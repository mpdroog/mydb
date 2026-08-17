package erm

import "regexp"

// backupPenalty is what a backup-shaped table name costs as a link target.
//
// It has to exceed ambiguityMargin, because the whole problem is a tie: a
// copy of a table carries the same primary-key name as the original and so
// scores identically. `amember_payment_logs.payment_id` matched both
// `amember_payments` and `amember_payments_b4encoding` at 0.95, the guard
// called it ambiguous, and the real relationship was never drawn.
const backupPenalty = 0.3

// backupRe recognises the names people give to a table they copied before
// changing something. Deliberately conservative: a false positive here
// demotes a legitimate table, so patterns that could plausibly be a real
// table (`_v2`, `_new`, `_archive`) are left out.
var backupRe = regexp.MustCompile(`(?i)` + `(` +
	// deleted_x, bak_x, tmp_x, old_x, copy_x, zz_x
	`^(deleted|del|bak|backup|tmp|temp|old|copy|orig|zz)_` +
	// x_bak, x_old, x_copy, x_copy1, x_tmp, x_orig, x_deleted, x_save(d)
	`|_(bak|backup|old|copy\d*|tmp|temp|orig|deleted|saved?|prev|previous)$` +
	// x_b4encoding, x_before_migration -- "before I broke it"
	`|_(b4|before)[a-z0-9_]*$` +
	// x_20240131, x_2024
	`|_(19|20)\d{2}(\d{2}\d{2})?$` +
	`)`)

// Backupish reports whether a table name looks like a copy kept aside
// rather than a table the application uses.
func Backupish(name string) bool {
	return backupRe.MatchString(name)
}

// intWidth is how many bytes an integer type holds, 0 when it is not an
// integer. Used to spot a child column too narrow to address its own key.
func intWidth(t string) int {
	base, _ := typeFamily(t)
	if base != "int" {
		return 0
	}
	switch bareType(t) {
	case "tinyint":
		return 1
	case "smallint":
		return 2
	case "mediumint":
		return 3
	case "int", "integer":
		return 4
	case "bigint":
		return 8
	}
	return 0
}
