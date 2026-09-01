package meta

import "testing"

// TestTableComment reads the table's own comment out of SHOW CREATE TABLE.
// The cases that matter are the ones where a column comment or an
// apostrophe could be mistaken for it.
func TestTableComment(t *testing.T) {
	for _, tc := range []struct {
		name, sql, want string
	}{
		{
			name: "plain",
			sql:  "CREATE TABLE `orders` (\n  `id` int NOT NULL\n) ENGINE=InnoDB COMMENT='one row per order'",
			want: "one row per order",
		},
		{
			// The one that matters: a column comment lives inside the
			// parentheses and must not be read as the table's.
			name: "column comment is not the table's",
			sql:  "CREATE TABLE `orders` (\n  `id` int NOT NULL COMMENT 'the key'\n) ENGINE=InnoDB",
			want: "",
		},
		{
			name: "column comment present, table comment also present",
			sql:  "CREATE TABLE `orders` (\n  `id` int COMMENT 'the key'\n) ENGINE=InnoDB COMMENT='the table'",
			want: "the table",
		},
		{
			// MySQL writes an apostrophe as \' rather than doubling it, so
			// a naive match ends the comment at the apostrophe.
			name: "apostrophe",
			sql:  "CREATE TABLE `t` (\n  `id` int\n) ENGINE=InnoDB COMMENT='it\\'s fine'",
			want: "it's fine",
		},
		{
			name: "backslash",
			sql:  "CREATE TABLE `t` (\n  `id` int\n) ENGINE=InnoDB COMMENT='a\\\\b'",
			want: `a\b`,
		},
		{name: "none", sql: "CREATE TABLE `t` (\n  `id` int\n) ENGINE=InnoDB", want: ""},
		{name: "empty input", sql: "", want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tableComment(tc.sql); got != tc.want {
				t.Errorf("tableComment = %q, want %q", got, tc.want)
			}
		})
	}
}
