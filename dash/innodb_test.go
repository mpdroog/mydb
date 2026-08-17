package dash

import (
	"strings"
	"testing"
)

// A trimmed but structurally faithful SHOW ENGINE INNODB STATUS. The point
// of the fixture is the fencing: a title is a line of dashes, the title,
// and another line of dashes, and the report itself is full of text that
// must not be mistaken for one.
const monitorOutput = `=====================================
2026-08-17 14:02:11 0x7f2a INNODB MONITOR OUTPUT
=====================================
Per second averages calculated from the last 41 seconds
-----------------
BACKGROUND THREAD
-----------------
srv_master_thread loops: 12 srv_active, 0 srv_shutdown
----------
SEMAPHORES
----------
OS WAIT ARRAY INFO: reservation count 41
------------------------
LATEST DETECTED DEADLOCK
------------------------
2026-08-17 13:58:02 0x7f2b
*** (1) TRANSACTION:
TRANSACTION 4212, ACTIVE 6 sec starting index read
mysql tables in use 1, locked 1
LOCK WAIT 3 lock struct(s), heap size 1136
UPDATE orders SET status = 'paid' WHERE id = 1
*** (2) TRANSACTION:
TRANSACTION 4213, ACTIVE 4 sec starting index read
UPDATE orders SET status = 'new' WHERE id = 2
*** WE ROLL BACK TRANSACTION (2)
------------
TRANSACTIONS
------------
Trx id counter 4300
---TRANSACTION 4299, not started
MySQL thread id 51, OS thread handle 139, query id 900 localhost root
----------------------
BUFFER POOL AND MEMORY
----------------------
Total large memory allocated 137428992
Dictionary memory allocated 415904
Buffer pool size   8192
--------------
ROW OPERATIONS
--------------
0 queries inside InnoDB, 0 queries in queue
----------------------------
END OF INNODB MONITOR OUTPUT
============================
`

func TestSections(t *testing.T) {
	got := sections(monitorOutput)

	for _, want := range []string{
		"BACKGROUND THREAD", "SEMAPHORES", "LATEST DETECTED DEADLOCK",
		"TRANSACTIONS", "BUFFER POOL AND MEMORY", "ROW OPERATIONS",
	} {
		if _, ok := got[want]; !ok {
			t.Errorf("section %q not found; got %v", want, keys(got))
		}
	}

	dead := got["LATEST DETECTED DEADLOCK"]
	if !strings.Contains(dead, "WE ROLL BACK TRANSACTION (2)") {
		t.Errorf("the deadlock section stops early:\n%s", dead)
	}
	// The section must end where the next one begins, or the deadlock panel
	// shows the rest of the report as part of the deadlock.
	if strings.Contains(dead, "Trx id counter") {
		t.Errorf("the deadlock section ran into TRANSACTIONS:\n%s", dead)
	}
	// The banner above the first fence belongs to no section.
	if strings.Contains(got["BACKGROUND THREAD"], "INNODB MONITOR OUTPUT") {
		t.Error("the banner leaked into the first section")
	}
}

func TestDeadlockTimestamp(t *testing.T) {
	if got := firstLine(sections(monitorOutput)["LATEST DETECTED DEADLOCK"]); got != "2026-08-17 13:58:02 0x7f2b" {
		t.Errorf("firstLine = %q, want the deadlock's timestamp", got)
	}
}

func TestTotalAllocated(t *testing.T) {
	for _, c := range []struct {
		name string
		in   string
		want int64
	}{
		{
			name: "mysql 8 / mariadb",
			in:   sections(monitorOutput)["BUFFER POOL AND MEMORY"],
			want: 137428992,
		},
		{
			name: "mysql 5.7 adds a second clause",
			in:   "Total memory allocated 137428992, in additional pool allocated 0",
			want: 137428992,
		},
		{name: "absent", in: "Buffer pool size 8192", want: 0},
		{name: "empty", in: "", want: 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := totalAllocated(c.in); got != c.want {
				t.Errorf("totalAllocated = %d, want %d", got, c.want)
			}
		})
	}
}

// A server that has never deadlocked has no such section, and the panel
// must stay away rather than showing an empty box.
func TestNoDeadlockSection(t *testing.T) {
	without := strings.Replace(monitorOutput,
		"------------------------\nLATEST DETECTED DEADLOCK\n------------------------\n", "", 1)
	if d := sections(without)["LATEST DETECTED DEADLOCK"]; d != "" {
		t.Errorf("found a deadlock section in output that has none: %q", d)
	}
}

func TestClip(t *testing.T) {
	long := strings.Repeat("line of a deadlock report\n", 100)
	got := clip(long, 200)
	if len(got) > 260 {
		t.Errorf("clip returned %d bytes for a 200-byte cap", len(got))
	}
	if !strings.HasSuffix(got, "(truncated)") {
		t.Error("a clipped report has to say it was clipped")
	}
	if clip("short", 200) != "short" {
		t.Error("clip must leave a short report alone")
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
