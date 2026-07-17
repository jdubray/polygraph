// Polygraph trace harness for the reference app's Order workflow.
//
// Drives the REAL workflow code (github.com/temporalio/reference-app-orders-go,
// app/order/workflows.go — unmodified) through Temporal's own testsuite.
// Ground truth is captured EVENT-DRIVEN: activity/child/timer completion
// listeners open a Polygraph window {pre, action, data, post}; `pre` is the
// tracked observable state, `post` is the workflow's own StatusQuery sampled
// one virtual millisecond later. Stub activities block on gates released at
// scripted VIRTUAL times, so ordering is deterministic and the workflow
// logic itself is never reimplemented here.
//
// Usage: go run . <traces-output-dir>
package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/temporalio/reference-app-orders-go/app/order"
	"github.com/temporalio/reference-app-orders-go/app/shipment"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	tlog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

// ---- observable projection (must match ../contract.json) -------------------

type Snapshot struct {
	Status       string   `json:"status"`
	Fulfillments []string `json:"fulfillments"`
}

func project(st *order.OrderStatus) Snapshot {
	fs := []string{}
	for _, f := range st.Fulfillments {
		fs = append(fs, string(f.Status))
	}
	return Snapshot{Status: string(st.Status), Fulfillments: fs}
}

type Window struct {
	Pre    Snapshot       `json:"pre"`
	Action string         `json:"action"`
	Data   map[string]any `json:"data"`
	Post   Snapshot       `json:"post"`
}

// ---- scenario scripting -----------------------------------------------------

type ChargeOutcome struct {
	At      time.Duration // virtual time the Charge activity is released
	Success bool
	Err     bool // non-retryable activity error instead of a result
}

type ShipOutcome struct {
	Sleep time.Duration // virtual time the Shipment child consumes before completing
	Ok    bool
}

type Scenario struct {
	Name           string
	Available      []bool
	CustomerAction string        // "amend" | "cancel" | "" (let the 30s timer fire)
	CustomerAt     time.Duration // signal time (virtual)
	Charges        map[string]ChargeOutcome // key: fulfillment suffix ":1", ":2"
	Ships          map[string]ShipOutcome
}

const reserveAt = 2 * time.Second

// ---- the driver -------------------------------------------------------------

type driver struct {
	sc      *Scenario
	env     *testsuite.TestWorkflowEnvironment
	current Snapshot
	windows []Window
	open    *Window // at most one window awaits its post snapshot
	errs    []string

	gates      map[string]chan struct{}
	lastCharge string // suffix recorded by the charge stub before returning
	shipDone   []string
	started    time.Time
}

func (d *driver) fail(format string, args ...any) {
	d.errs = append(d.errs, fmt.Sprintf(format, args...))
}

func (d *driver) query() (Snapshot, bool) {
	v, err := d.env.QueryWorkflow(order.StatusQuery)
	if err != nil {
		return Snapshot{}, false
	}
	var st order.OrderStatus
	if err := v.Get(&st); err != nil {
		return Snapshot{}, false
	}
	return project(&st), true
}

// openWindow records `pre` now and schedules the post-snapshot one virtual
// millisecond later. Events are scripted seconds apart, so windows never
// overlap; overlap is a harness bug and fails the scenario loudly.
func (d *driver) openWindow(action string, data map[string]any) {
	if d.open != nil {
		d.fail("window overlap: %s opened while %s pending", action, d.open.Action)
		return
	}
	w := &Window{Pre: d.current, Action: action, Data: data}
	d.open = w
	d.env.RegisterDelayedCallback(func() {
		if snap, ok := d.query(); ok {
			d.closeWindow(snap)
		}
		// If the workflow already completed, the final fix-up in run() closes it.
	}, time.Millisecond)
}

func (d *driver) closeWindow(snap Snapshot) {
	if d.open == nil {
		return
	}
	d.open.Post = snap
	d.windows = append(d.windows, *d.open)
	d.current = snap
	d.open = nil
}

func quietLogger() tlog.Logger {
	return tlog.NewStructuredLogger(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError})))
}

func run(sc *Scenario) ([]Window, error) {
	var ts testsuite.WorkflowTestSuite
	ts.SetLogger(quietLogger())
	env := ts.NewTestWorkflowEnvironment()

	d := &driver{
		sc:      sc,
		env:     env,
		current: Snapshot{Status: "pending", Fulfillments: []string{}},
		gates:   map[string]chan struct{}{},
	}

	env.RegisterWorkflow(order.Order)
	env.RegisterWorkflowWithOptions(func(ctx workflow.Context, input shipment.ShipmentInput) error {
		suffix := input.ID[len(input.ID)-2:]
		out := sc.Ships[suffix]
		_ = workflow.Sleep(ctx, out.Sleep)
		d.shipDone = append(d.shipDone, suffix)
		if !out.Ok {
			return fmt.Errorf("shipment failed")
		}
		return nil
	}, workflow.RegisterOptions{Name: "Shipment"})

	// Gated stub activities: released at scripted virtual times.
	gate := func(name string, at time.Duration) chan struct{} {
		ch := make(chan struct{})
		d.gates[name] = ch
		env.RegisterDelayedCallback(func() { close(ch) }, at)
		return ch
	}
	reserveGate := gate("reserve", reserveAt)
	for suffix, out := range sc.Charges {
		gate("charge"+suffix, out.At)
		_ = out
	}

	env.RegisterActivityWithOptions(func(input *order.ReserveItemsInput) (*order.ReserveItemsResult, error) {
		<-reserveGate
		var res order.ReserveItemsResult
		for i, avail := range sc.Available {
			res.Reservations = append(res.Reservations, &order.Reservation{
				Available: avail,
				Location:  fmt.Sprintf("warehouse-%d", i+1),
				Items:     input.Items[i : i+1],
			})
		}
		return &res, nil
	}, activity.RegisterOptions{Name: "ReserveItems"})

	env.RegisterActivityWithOptions(func(input *order.ChargeInput) (*order.ChargeResult, error) {
		suffix := input.Reference[len(input.Reference)-2:]
		if ch, okG := d.gates["charge"+suffix]; okG {
			<-ch
		}
		d.lastCharge = suffix
		out := sc.Charges[suffix]
		if out.Err {
			return nil, temporal.NewNonRetryableApplicationError("charge provider unavailable", "ProviderDown", nil)
		}
		return &order.ChargeResult{SubTotal: 100, Tax: 10, Shipping: 5, Total: 115, Success: out.Success}, nil
	}, activity.RegisterOptions{Name: "Charge"})

	env.RegisterActivityWithOptions(func(x *order.OrderStatusInsert) error { return nil }, activity.RegisterOptions{Name: "InsertOrder"})
	env.RegisterActivityWithOptions(func(x *order.OrderStatusUpdate) error { return nil }, activity.RegisterOptions{Name: "UpdateOrderStatus"})

	suffixIndex := func(suffix string) int {
		var i int
		fmt.Sscanf(suffix, ":%d", &i)
		return i - 1
	}

	// ---- event-driven window capture ----
	env.SetOnActivityCompletedListener(func(info *activity.Info, _ converter.EncodedValue, _ error) {
		switch info.ActivityType.Name {
		case "ReserveItems":
			avail := make([]any, len(sc.Available))
			for i, a := range sc.Available {
				avail[i] = a
			}
			d.openWindow("RESERVED", map[string]any{"available": avail})
		case "Charge":
			out := sc.Charges[d.lastCharge]
			d.openWindow("CHARGE_RESULT", map[string]any{
				"index":   suffixIndex(d.lastCharge),
				"success": out.Success && !out.Err,
			})
		}
	})
	env.SetOnChildWorkflowCompletedListener(func(_ *workflow.Info, _ converter.EncodedValue, _ error) {
		if len(d.shipDone) == 0 {
			d.fail("child completed with no recorded suffix")
			return
		}
		suffix := d.shipDone[len(d.shipDone)-1]
		d.openWindow("SHIPMENT_RESULT", map[string]any{
			"index": suffixIndex(suffix),
			"ok":    sc.Ships[suffix].Ok,
		})
	})
	expectTimeout := sc.CustomerAction == ""
	env.SetOnTimerFiredListener(func(_ string) {
		// The only meaningful timer at customerActionRequired, late in virtual
		// time, is the workflow's 30s customer-action timer (our own
		// millisecond close-callbacks fire long before it).
		if expectTimeout && d.open == nil && d.current.Status == "customerActionRequired" && d.env.Now().Sub(d.started) > 25*time.Second {
			d.openWindow("CUSTOMER_TIMEOUT", map[string]any{})
		}
	})
	if sc.CustomerAction != "" {
		env.RegisterDelayedCallback(func() {
			d.openWindow("CUSTOMER_ACTION", map[string]any{"action": sc.CustomerAction})
			env.SignalWorkflow(order.CustomerActionSignalName, &order.CustomerActionSignal{Action: sc.CustomerAction})
		}, sc.CustomerAt)
	}

	d.started = env.Now()
	env.ExecuteWorkflow(order.Order, &order.OrderInput{
		ID:         "order-audit",
		CustomerID: "cust-1",
		Items:      itemsFor(len(sc.Available)),
	})
	if err := env.GetWorkflowError(); err != nil {
		return nil, fmt.Errorf("workflow error: %w", err)
	}

	// The final action's post-snapshot callback may never fire (the workflow
	// completed first): close it with a direct post-completion query — the
	// query handler still serves the workflow's final state.
	if d.open != nil {
		snap, ok := d.query()
		if !ok {
			return nil, fmt.Errorf("cannot query final state for open %s window", d.open.Action)
		}
		d.closeWindow(snap)
	}
	if len(d.errs) > 0 {
		return nil, fmt.Errorf("harness defects: %v", d.errs)
	}
	return d.windows, nil
}

func itemsFor(n int) []*order.Item {
	var items []*order.Item
	for i := 0; i < n; i++ {
		items = append(items, &order.Item{SKU: fmt.Sprintf("sku-%d", i+1), Quantity: 1})
	}
	return items
}

// ---- scenarios ---------------------------------------------------------------

func scenarios() []*Scenario {
	sec := func(n int) time.Duration { return time.Duration(n) * time.Second }
	return []*Scenario{
		{
			Name:      "s1_happy_two_fulfillments",
			Available: []bool{true, true},
			Charges:   map[string]ChargeOutcome{":1": {At: sec(4), Success: true}, ":2": {At: sec(6), Success: true}},
			Ships:     map[string]ShipOutcome{":1": {Sleep: sec(4), Ok: true}, ":2": {Sleep: sec(8), Ok: true}},
		},
		{
			Name:      "s2_amend_then_complete",
			Available: []bool{true, false},
			CustomerAction: "amend", CustomerAt: sec(6),
			Charges: map[string]ChargeOutcome{":1": {At: sec(8), Success: true}},
			Ships:   map[string]ShipOutcome{":1": {Sleep: sec(3), Ok: true}},
		},
		{
			Name:      "s3_customer_cancel",
			Available: []bool{true, false},
			CustomerAction: "cancel", CustomerAt: sec(6),
			Charges: map[string]ChargeOutcome{},
			Ships:   map[string]ShipOutcome{},
		},
		{
			Name:      "s4_customer_timeout",
			Available: []bool{false},
			Charges:   map[string]ChargeOutcome{},
			Ships:     map[string]ShipOutcome{},
		},
		{
			Name:      "s5_charge_declined_single",
			Available: []bool{true},
			Charges:   map[string]ChargeOutcome{":1": {At: sec(4), Success: false}},
			Ships:     map[string]ShipOutcome{},
		},
		{
			Name:      "s6_charge_error_single",
			Available: []bool{true},
			Charges:   map[string]ChargeOutcome{":1": {At: sec(4), Err: true}},
			Ships:     map[string]ShipOutcome{},
		},
		{
			Name:      "s7_partial_shipment_failure",
			Available: []bool{true, true},
			Charges:   map[string]ChargeOutcome{":1": {At: sec(4), Success: true}, ":2": {At: sec(6), Success: true}},
			Ships:     map[string]ShipOutcome{":1": {Sleep: sec(4), Ok: true}, ":2": {Sleep: sec(8), Ok: false}},
		},
		{
			Name:      "s8_all_unavailable_amend_completes_empty",
			Available: []bool{false, false},
			CustomerAction: "amend", CustomerAt: sec(6),
			Charges: map[string]ChargeOutcome{},
			Ships:   map[string]ShipOutcome{},
		},
		{
			Name:      "s9_both_charges_fail_order_failed",
			Available: []bool{true, true},
			Charges:   map[string]ChargeOutcome{":1": {At: sec(4), Success: false}, ":2": {At: sec(6), Success: false}},
			Ships:     map[string]ShipOutcome{},
		},
	}
}

func writeTrace(outDir, name string, rows []any) int {
	f, err := os.Create(filepath.Join(outDir, name+".ndjson"))
	if err != nil {
		panic(err)
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	for _, w := range rows {
		if err := enc.Encode(w); err != nil {
			panic(err)
		}
	}
	return len(rows)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: go run . <traces-output-dir> [order|shipment]")
		os.Exit(2)
	}
	outDir := os.Args[1]
	mode := "order"
	if len(os.Args) > 2 {
		mode = os.Args[2]
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		panic(err)
	}
	total := 0
	switch mode {
	case "order":
		for _, sc := range scenarios() {
			windows, err := run(sc)
			if err != nil {
				fmt.Fprintf(os.Stderr, "%s: %v\n", sc.Name, err)
				os.Exit(1)
			}
			rows := make([]any, len(windows))
			for i, w := range windows {
				rows[i] = w
			}
			total += writeTrace(outDir, sc.Name, rows)
			fmt.Printf("%-45s %d window(s), final %s %v\n", sc.Name, len(windows), windows[len(windows)-1].Post.Status, windows[len(windows)-1].Post.Fulfillments)
		}
	case "shipment":
		for _, sc := range shipmentScenarios() {
			windows, err := runShipment(sc)
			if err != nil {
				fmt.Fprintf(os.Stderr, "%s: %v\n", sc.Name, err)
				os.Exit(1)
			}
			rows := make([]any, len(windows))
			for i, w := range windows {
				rows[i] = w
			}
			total += writeTrace(outDir, sc.Name, rows)
			fmt.Printf("%-45s %d window(s), final %s\n", sc.Name, len(windows), windows[len(windows)-1].Post.Status)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown mode "+mode)
		os.Exit(2)
	}
	fmt.Printf("TOTAL: %d windows\n", total)
}
