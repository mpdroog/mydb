package erm

import (
	"strings"
	"testing"
)

func TestBackupish(t *testing.T) {
	for _, name := range []string{
		// The two that actually broke a real schema.
		"amember_payments_b4encoding", "amember_members_copy1", "deleted_chimpsync",
		"orders_bak", "orders_backup", "orders_old", "orders_copy", "orders_copy2",
		"orders_tmp", "orders_temp", "orders_orig", "orders_deleted", "orders_saved",
		"orders_before_migration", "orders_20240131", "orders_2024",
		"bak_orders", "tmp_orders", "old_orders", "zz_orders", "del_orders",
	} {
		if !Backupish(name) {
			t.Errorf("%q should read as a backup", name)
		}
	}

	// A false positive demotes a real table, so these must all survive.
	for _, name := range []string{
		"orders", "amember_payments", "amember_members", "payments_v2",
		"order_items", "b4_something_real", "coupon", "copyright_notices",
		"templates", "temperatures", "oldest_records", "backups",
		"archive_policy", "saved_searches", "previously_viewed",
	} {
		if Backupish(name) {
			t.Errorf("%q is a real table, not a backup", name)
		}
	}
}

// TestBackupDoesNotStealTheLink is the reported bug: a copy carries the same
// primary-key name as the original, ties at the same score, and the
// ambiguity guard then refused to draw either.
func TestBackupDoesNotStealTheLink(t *testing.T) {
	intu := func(n string) Column { return Column{Name: n, Type: "int(11) unsigned"} }

	tables := []Table{
		{Name: "amember_payments", PrimaryKey: []string{"payment_id"},
			Columns: []Column{intu("payment_id")}},
		{Name: "amember_payments_b4encoding", PrimaryKey: []string{"payment_id"},
			Columns: []Column{intu("payment_id")}},
		{Name: "amember_payment_logs", PrimaryKey: []string{"log_id"},
			Columns: []Column{intu("log_id"), intu("payment_id")}},
	}
	l := found(first(Infer(tables, nil)), "amember_payment_logs", "amember_payments")
	if l == nil {
		t.Fatal("payment_id still not linked to amember_payments")
	}
	if x := found(first(Infer(tables, nil)), "amember_payment_logs", "amember_payments_b4encoding"); x != nil {
		t.Errorf("linked to the backup copy instead: %+v", x)
	}
}

func TestBackupWithSeveralCopies(t *testing.T) {
	// The member_id case: two copies plus an unrelated deleted_ table.
	tables := []Table{
		{Name: "amember_members", PrimaryKey: []string{"member_id"},
			Columns: []Column{{Name: "member_id", Type: "int(11) unsigned"}}},
		{Name: "amember_members_copy1", PrimaryKey: []string{"member_id"},
			Columns: []Column{{Name: "member_id", Type: "int(11) unsigned"}}},
		{Name: "deleted_chimpsync", PrimaryKey: []string{"member_id"},
			Columns: []Column{{Name: "member_id", Type: "int(11) unsigned"}}},
		{Name: "amember_notes", PrimaryKey: []string{"note_id"},
			Columns: []Column{
				{Name: "note_id", Type: "int(11) unsigned"},
				{Name: "member_id", Type: "tinyint(4)"}}},
	}
	links, _ := Infer(tables, nil)
	l := found(links, "amember_notes", "amember_members")
	if l == nil {
		t.Fatal("member_id still not linked to amember_members")
	}
	// tinyint cannot address an int key: a real bug, and it must be said.
	if !strings.Contains(l.Rule, "narrower than its key") {
		t.Errorf("the tinyint/int mismatch was not reported: %q", l.Rule)
	}
}

// TestOwnPrimaryKeyIsNotAReference: a table's own identity column has
// nowhere to point, and reporting it every time buried the real gaps.
func TestOwnPrimaryKeyIsNotAReference(t *testing.T) {
	tables := []Table{
		{Name: "amember_members", PrimaryKey: []string{"member_id"},
			Columns: []Column{{Name: "member_id", Type: "int(11) unsigned"}}},
		{Name: "amember_members_copy1", PrimaryKey: []string{"member_id"},
			Columns: []Column{{Name: "member_id", Type: "int(11) unsigned"}}},
	}
	links, miss := Infer(tables, nil)
	if len(links) != 0 {
		t.Errorf("a real table linked to a copy of itself: %+v", links)
	}
	for _, m := range miss {
		if m.Table == "amember_members" && m.Column == "member_id" {
			t.Errorf("a table's own primary key was reported as an unlinked key: %+v", m)
		}
	}
}

// TestOneToOneExtensionStillLinks: a primary key that is *also* a foreign
// key is a real pattern, and the rule above must not swallow it.
func TestOneToOneExtensionStillLinks(t *testing.T) {
	tables := []Table{
		{Name: "users", PrimaryKey: []string{"id"},
			Columns: []Column{{Name: "id", Type: "int(11)"}}},
		{Name: "user_profiles", PrimaryKey: []string{"user_id"},
			Columns: []Column{{Name: "user_id", Type: "int(11)"},
				{Name: "bio", Type: "text"}}},
	}
	if l := found(first(Infer(tables, nil)), "user_profiles", "users"); l == nil {
		t.Error("a 1:1 extension table did not link on its own primary key")
	}
}
