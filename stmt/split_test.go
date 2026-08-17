package stmt

import "testing"

// TestSplit is the guard on the console's multi-statement support. A
// semicolon inside a string is the case that turns a working script into
// two broken halves, so most of these are about quoting.
func TestSplit(t *testing.T) {
	for _, c := range []struct {
		name string
		in   string
		want []string
	}{
		{name: "empty", in: "", want: nil},
		{name: "blank", in: "   \n\t ", want: nil},
		{name: "one", in: "SELECT 1", want: []string{"SELECT 1"}},
		{name: "one trailing ;", in: "SELECT 1;", want: []string{"SELECT 1"}},
		{name: "two", in: "SELECT 1; SELECT 2", want: []string{"SELECT 1", "SELECT 2"}},
		{
			name: "newline separated",
			in:   "SELECT 1;\nSELECT 2;\n",
			want: []string{"SELECT 1", "SELECT 2"},
		},
		{name: "empty statements dropped", in: ";;SELECT 1;;", want: []string{"SELECT 1"}},

		// The whole reason this is not a strings.Split.
		{
			name: "semicolon in a string literal",
			in:   "INSERT INTO t VALUES ('a;b'); SELECT 2",
			want: []string{"INSERT INTO t VALUES ('a;b')", "SELECT 2"},
		},
		{
			name: "semicolon in a quoted identifier",
			in:   "SELECT `we;ird` FROM t; SELECT 2",
			want: []string{"SELECT `we;ird` FROM t", "SELECT 2"},
		},
		{
			name: "semicolon in a line comment",
			in:   "SELECT 1 -- ; not a boundary\n; SELECT 2",
			want: []string{"SELECT 1 -- ; not a boundary", "SELECT 2"},
		},
		{
			name: "semicolon in a block comment",
			in:   "SELECT 1 /* ; */ ; SELECT 2",
			want: []string{"SELECT 1 /* ; */", "SELECT 2"},
		},
		{
			name: "escaped quote does not end the literal",
			in:   `SELECT 'it\'s; fine'; SELECT 2`,
			want: []string{`SELECT 'it\'s; fine'`, "SELECT 2"},
		},
		{
			name: "doubled quote does not end the literal",
			in:   "SELECT 'it''s; fine'; SELECT 2",
			want: []string{"SELECT 'it''s; fine'", "SELECT 2"},
		},
		{
			name: "comment-only tail is not a statement",
			in:   "SELECT 1; -- done\n",
			want: []string{"SELECT 1"},
		},

		// A routine body carries its own semicolons and the mysql client
		// needs DELIMITER for it. Splitting would cut the body in half.
		{
			name: "stored procedure is left whole",
			in:   "CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END",
			want: []string{"CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END"},
		},
		{
			name: "trigger with a definer is left whole",
			in:   "CREATE DEFINER=`root`@`localhost` TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET @a=1; END",
			want: []string{"CREATE DEFINER=`root`@`localhost` TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET @a=1; END"},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := Split(c.in)
			if len(got) != len(c.want) {
				t.Fatalf("Split(%q) gave %d statements, want %d: %#v", c.in, len(got), len(c.want), got)
			}
			for i, w := range c.want {
				if got[i].SQL != w {
					t.Errorf("statement %d = %q, want %q", i, got[i].SQL, w)
				}
				// The offsets have to point back at the source, or the
				// console runs the wrong statement under the cursor.
				if c.in[got[i].Start:got[i].End] != got[i].SQL {
					t.Errorf("statement %d offsets %d:%d do not slice back to it",
						i, got[i].Start, got[i].End)
				}
			}
		})
	}
}
