package dash

import (
	"context"
	"strings"

	"github.com/mpdroog/mydb/meta"
)

// loadInnoDB reads SHOW ENGINE INNODB STATUS.
//
// This is the only place mydb parses free text out of a server, and it is
// here because there is no structured alternative: the last deadlock is not
// in any table on either fork. Everything numeric comes from status
// variables instead, so a parse that comes up empty costs a panel and
// nothing else.
func (c *Collector) loadInnoDB(ctx context.Context, q meta.Querier, s *Snapshot) {
	if c.innodb == sourceGone {
		return
	}
	res, e := meta.Query(ctx, q, 1, "SHOW ENGINE INNODB STATUS")
	if e != nil || len(res.Rows) == 0 {
		c.innodb = sourceGone
		why := "no rows"
		if e != nil {
			why = short(e.Error())
		}
		s.note("InnoDB monitor output unavailable, so the last deadlock cannot "+
			"be shown: %s", why)
		return
	}
	c.innodb = sourceOK

	// SHOW ENGINE INNODB STATUS answers Type/Name/Status; the report is the
	// last column whichever fork we are on.
	row := res.Rows[0]
	text := str(row, len(row)-1)
	secs := sections(text)

	if d := secs["LATEST DETECTED DEADLOCK"]; d != "" {
		s.Deadlock = &Deadlock{At: firstLine(d), Text: clip(d, maxDeadlock)}
	}
	s.Memory.InnoDBAlloc = totalAllocated(secs["BUFFER POOL AND MEMORY"])
}

// sections splits the monitor output into its titled blocks.
//
// The format is a title fenced above and below by a line of dashes:
//
//	------------------------
//	LATEST DETECTED DEADLOCK
//	------------------------
//	<the report>
//
// Anything not inside such a fence — the banner at the top, the "END OF
// INNODB MONITOR OUTPUT" line — is skipped.
func sections(text string) map[string]string {
	lines := strings.Split(text, "\n")
	out := make(map[string]string, 12)

	title := ""
	var body []string
	flush := func() {
		if title != "" {
			out[title] = strings.TrimRight(strings.Join(body, "\n"), "\n ")
		}
		body = body[:0]
	}

	for i := 0; i < len(lines); i++ {
		if isFence(lines[i]) && i+2 < len(lines) &&
			isTitle(lines[i+1]) && isFence(lines[i+2]) {
			flush()
			title = strings.TrimSpace(lines[i+1])
			i += 2
			continue
		}
		if title != "" {
			body = append(body, lines[i])
		}
	}
	flush()
	return out
}

// isFence reports whether a line is one of the dashed rules around a title.
func isFence(s string) bool {
	s = strings.TrimRight(s, "\r")
	if len(s) < 4 {
		return false
	}
	return strings.Trim(s, "-") == ""
}

// isTitle reports whether a line looks like a section heading: upper-case
// words, and nothing that would make it a sentence of the report.
func isTitle(s string) bool {
	s = strings.TrimSpace(strings.TrimRight(s, "\r"))
	if s == "" || len(s) > 60 {
		return false
	}
	for i := range len(s) {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c == ' ' || c == '/' || c == '-' {
			continue
		}
		return false
	}
	return true
}

// firstLine returns the first non-empty line, which for a deadlock report
// is the timestamp it happened at.
func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return l
		}
	}
	return ""
}

// clip truncates a report to n bytes, on a line boundary where it can.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	if i := strings.LastIndexByte(s, '\n'); i > n/2 {
		s = s[:i]
	}
	return s + "\n… (truncated)"
}

// totalAllocated reads "Total large memory allocated 137428992" out of the
// buffer-pool section. This is what InnoDB holds in total, which is more
// than the buffer pool itself and is the number worth watching next to the
// machine's own RAM.
func totalAllocated(section string) int64 {
	for _, l := range strings.Split(section, "\n") {
		l = strings.TrimSpace(l)
		for _, prefix := range []string{
			"Total large memory allocated ",
			"Total memory allocated ",
		} {
			if rest, ok := strings.CutPrefix(l, prefix); ok {
				// MySQL 5.7 adds ", in additional pool allocated 0".
				if i := strings.IndexByte(rest, ','); i > 0 {
					rest = rest[:i]
				}
				return atoi(rest)
			}
		}
	}
	return 0
}
