package erm

import "testing"

// The amember pattern: the primary key is named after the table, not "id".
func TestAmemberPattern(t *testing.T) {
	tables := []Table{
		{Name: "amember_payments", PrimaryKey: []string{"payment_id"}, Columns: []Column{
			{Name: "payment_id", Type: "int(11) unsigned", Key: "PRI"}}},
		{Name: "xsnews_payment", PrimaryKey: []string{"id"}, Columns: []Column{
			{Name: "id", Type: "int(11)", Key: "PRI"},
			{Name: "payment_id", Type: "int(11) unsigned"}}},
	}
	if l := found(first(Infer(tables, nil)), "xsnews_payment", "amember_payments"); l == nil {
		t.Error("MISSED: xsnews_payment.payment_id -> amember_payments.payment_id")
	} else {
		t.Logf("found at %.2f via %q", l.Confidence, l.Rule)
	}
}

// Same, but the signedness disagrees -- common in legacy schemas.
func TestAmemberPatternSignedMismatch(t *testing.T) {
	tables := []Table{
		{Name: "amember_payments", PrimaryKey: []string{"payment_id"}, Columns: []Column{
			{Name: "payment_id", Type: "int(11) unsigned", Key: "PRI"}}},
		{Name: "xsnews_payment", PrimaryKey: []string{"id"}, Columns: []Column{
			{Name: "id", Type: "int(11)", Key: "PRI"},
			{Name: "payment_id", Type: "int(11)"}}},
	}
	if l := found(first(Infer(tables, nil)), "xsnews_payment", "amember_payments"); l == nil {
		t.Error("MISSED (signed vs unsigned)")
	} else {
		t.Logf("found at %.2f via %q", l.Confidence, l.Rule)
	}
}

// A second table also ending in _payment must not silently kill the match.
func TestAmemberPatternWithNeighbour(t *testing.T) {
	tables := []Table{
		{Name: "amember_payments", PrimaryKey: []string{"payment_id"}, Columns: []Column{
			{Name: "payment_id", Type: "int(11) unsigned", Key: "PRI"}}},
		{Name: "amember_invoice_payment", PrimaryKey: []string{"invoice_payment_id"}, Columns: []Column{
			{Name: "invoice_payment_id", Type: "int(11) unsigned", Key: "PRI"}}},
		{Name: "xsnews_payment", PrimaryKey: []string{"id"}, Columns: []Column{
			{Name: "id", Type: "int(11)", Key: "PRI"},
			{Name: "payment_id", Type: "int(11) unsigned"}}},
	}
	if l := found(first(Infer(tables, nil)), "xsnews_payment", "amember_payments"); l == nil {
		t.Error("MISSED (a sibling table ending in _payment stole the match)")
	} else {
		t.Logf("found at %.2f via %q", l.Confidence, l.Rule)
	}
}
