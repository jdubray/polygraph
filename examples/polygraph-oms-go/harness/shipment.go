// Shipment-workflow trace capture — same method as the Order harness
// (see main.go): the REAL shipment.Shipment workflow, unmodified, driven
// through Temporal's testsuite with a gated BookShipment stub and
// virtual-time carrier signals; windows anchored on completion listeners
// and signal callbacks, post-states from the workflow's own StatusQuery.
package main

import (
	"fmt"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/temporalio/reference-app-orders-go/app/shipment"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/testsuite"
)

type shipmentSnapshot struct {
	Status string `json:"status"`
	Booked bool   `json:"booked"`
}

type carrierUpdate struct {
	At     time.Duration
	Status string
}

type shipmentScenario struct {
	Name    string
	BookAt  time.Duration
	Updates []carrierUpdate
}

// sWindow mirrors Window with the shipment's own (fulfillment-free) shape.
type sWindow struct {
	Pre    shipmentSnapshot `json:"pre"`
	Action string           `json:"action"`
	Data   map[string]any   `json:"data"`
	Post   shipmentSnapshot `json:"post"`
}

type shipmentDriver struct {
	env     *testsuite.TestWorkflowEnvironment
	current shipmentSnapshot
	windows []sWindow
	open    *sWindow
	errs    []string
	booked  bool // BookShipment completed — part of the observable projection
}

func (d *shipmentDriver) query() (shipmentSnapshot, bool) {
	v, err := d.env.QueryWorkflow(shipment.StatusQuery)
	if err != nil {
		return shipmentSnapshot{}, false
	}
	var st shipment.ShipmentStatus
	if err := v.Get(&st); err != nil {
		return shipmentSnapshot{}, false
	}
	return shipmentSnapshot{Status: string(st.Status), Booked: d.booked}, true
}

func (d *shipmentDriver) openWindow(action string, data map[string]any) {
	if d.open != nil {
		d.errs = append(d.errs, fmt.Sprintf("window overlap: %s while %s pending", action, d.open.Action))
		return
	}
	w := &sWindow{Pre: d.current, Action: action, Data: data}
	d.open = w
	d.env.RegisterDelayedCallback(func() {
		if s, ok := d.query(); ok {
			d.closeWindow(s)
		}
	}, time.Millisecond)
}

func (d *shipmentDriver) closeWindow(s shipmentSnapshot) {
	if d.open == nil {
		return
	}
	d.open.Post = s
	d.windows = append(d.windows, *d.open)
	d.current = s
	d.open = nil
}

func runShipment(sc *shipmentScenario) ([]sWindow, error) {
	var ts testsuite.WorkflowTestSuite
	ts.SetLogger(quietLogger())
	env := ts.NewTestWorkflowEnvironment()

	d := &shipmentDriver{env: env, current: shipmentSnapshot{Status: "pending"}}

	env.RegisterWorkflow(shipment.Shipment)

	bookGate := make(chan struct{})
	env.RegisterDelayedCallback(func() { close(bookGate) }, sc.BookAt)
	env.RegisterActivityWithOptions(func(input *shipment.BookShipmentInput) (*shipment.BookShipmentResult, error) {
		<-bookGate
		return &shipment.BookShipmentResult{CourierReference: "courier-ref-1"}, nil
	}, activity.RegisterOptions{Name: "BookShipment"})
	env.RegisterActivityWithOptions(func(x *shipment.ShipmentStatusUpdate) error { return nil }, activity.RegisterOptions{Name: "UpdateShipmentStatus"})

	// The workflow signals its requestor (the order) on every update.
	env.OnSignalExternalWorkflow(mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).Return(nil)

	env.SetOnActivityCompletedListener(func(info *activity.Info, _ converter.EncodedValue, _ error) {
		if info.ActivityType.Name == "BookShipment" {
			d.openWindow("BOOKED", map[string]any{})
			d.booked = true
		}
	})

	for _, u := range sc.Updates {
		u := u
		env.RegisterDelayedCallback(func() {
			d.openWindow("CARRIER_UPDATE", map[string]any{"status": u.Status})
			env.SignalWorkflow(shipment.ShipmentCarrierUpdateSignalName, &shipment.ShipmentCarrierUpdateSignal{Status: u.Status})
		}, u.At)
	}

	env.ExecuteWorkflow(shipment.Shipment, &shipment.ShipmentInput{
		RequestorWID: "order-audit",
		ID:           "shipment-audit:1",
		Items:        []shipment.Item{{SKU: "sku-1", Quantity: 1}},
	})
	if err := env.GetWorkflowError(); err != nil {
		return nil, fmt.Errorf("workflow error: %w", err)
	}
	if d.open != nil {
		s, ok := d.query()
		if !ok {
			return nil, fmt.Errorf("cannot query final state for open %s window", d.open.Action)
		}
		d.closeWindow(s)
	}
	if len(d.errs) > 0 {
		return nil, fmt.Errorf("harness defects: %v", d.errs)
	}
	return d.windows, nil
}

func shipmentScenarios() []*shipmentScenario {
	sec := func(n int) time.Duration { return time.Duration(n) * time.Second }
	return []*shipmentScenario{
		{
			Name:   "t1_normal_progression",
			BookAt: sec(2),
			Updates: []carrierUpdate{
				{At: sec(4), Status: "dispatched"},
				{At: sec(6), Status: "delivered"},
			},
		},
		{
			Name:   "t2_direct_delivery_skips_dispatch",
			BookAt: sec(2),
			Updates: []carrierUpdate{
				{At: sec(4), Status: "delivered"},
			},
		},
		{
			Name:   "t3_status_regression",
			BookAt: sec(2),
			Updates: []carrierUpdate{
				{At: sec(4), Status: "dispatched"},
				{At: sec(6), Status: "booked"}, // the carrier moves the shipment BACKWARDS
				{At: sec(8), Status: "dispatched"},
				{At: sec(10), Status: "delivered"},
			},
		},
		{
			Name:   "t4_bogus_carrier_status",
			BookAt: sec(2),
			Updates: []carrierUpdate{
				{At: sec(4), Status: "lost-in-transit"}, // outside the documented enum, applied verbatim
				{At: sec(6), Status: "delivered"},
			},
		},
		{
			Name:   "t6_regression_to_pending_then_onward",
			BookAt: sec(2),
			Updates: []carrierUpdate{
				{At: sec(4), Status: "pending"}, // carrier drags it back to PENDING
				{At: sec(6), Status: "dispatched"},
				{At: sec(8), Status: "delivered"},
			},
		},
		{
			Name:   "t5_duplicate_update",
			BookAt: sec(2),
			Updates: []carrierUpdate{
				{At: sec(4), Status: "dispatched"},
				{At: sec(6), Status: "dispatched"},
				{At: sec(8), Status: "delivered"},
			},
		},
	}
}
