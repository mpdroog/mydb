// Package meta reads schema information out of MySQL and turns result-sets
// into something the browser can render without guessing at types.
package meta

import (
	"context"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"strings"
	"time"
)

// MaxCell is the largest single value we ship to the browser, a LONGTEXT
// column must not be able to wedge the grid.
const MaxCell = 64 << 10 // 64KiB

// MaxResultBytes caps a whole result-set, so a wide table of MEDIUMTEXT
// cannot balloon this process.
const MaxResultBytes = 32 << 20 // 32MiB

// binaryTypes are the column types we hex-encode instead of shipping raw,
// because they are not valid UTF-8 and would break the JSON encoder.
var binaryTypes = map[string]bool{
	"BINARY":     true,
	"VARBINARY":  true,
	"BLOB":       true,
	"TINYBLOB":   true,
	"MEDIUMBLOB": true,
	"LONGBLOB":   true,
	"GEOMETRY":   true,
	"BIT":        true,
}

// Column describes one column of a result-set.
type Column struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
	Binary   bool   `json:"binary"`
}

// Result is a result-set on its way to the browser. A nil entry in a row
// is SQL NULL, which is deliberately distinct from an empty string.
type Result struct {
	Cols      []Column   `json:"cols"`
	Rows      [][]*string `json:"rows"`
	Elapsed   int64      `json:"elapsed_ms"`
	Truncated bool       `json:"truncated"`
}

// Querier is satisfied by *sql.DB, *sql.Conn and *sql.Tx.
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// Query runs a statement and reads the whole result-set into memory,
// stopping at limit rows or MaxResultBytes, whichever comes first.
func Query(ctx context.Context, q Querier, limit int, query string, args ...any) (*Result, error) {
	begin := time.Now()

	rows, e := q.QueryContext(ctx, query, args...)
	if e != nil {
		return nil, fmt.Errorf("meta.Query: %w", e)
	}
	defer func() {
		if e := rows.Close(); e != nil {
			log.Printf("meta.Query rows.Close: %s", e)
		}
	}()

	cols, e := columns(rows)
	if e != nil {
		return nil, e
	}

	out := &Result{Cols: cols, Rows: make([][]*string, 0, 64)}
	raw := make([]sql.RawBytes, len(cols))
	scan := make([]any, len(cols))
	for i := range raw {
		scan[i] = &raw[i]
	}

	budget := MaxResultBytes
	for rows.Next() {
		if limit > 0 && len(out.Rows) >= limit {
			out.Truncated = true
			break
		}
		if e := rows.Scan(scan...); e != nil {
			return nil, fmt.Errorf("meta.Query scan: %w", e)
		}

		row := make([]*string, len(cols))
		for i, b := range raw {
			if b == nil {
				continue // SQL NULL
			}
			v := encode(b, cols[i].Binary)
			budget -= len(v)
			row[i] = &v
		}
		out.Rows = append(out.Rows, row)

		if budget <= 0 {
			out.Truncated = true
			break
		}
	}
	// The check that catches a tunnel dying halfway through a result-set.
	if e := rows.Err(); e != nil {
		return nil, fmt.Errorf("meta.Query rows: %w", e)
	}

	out.Elapsed = time.Since(begin).Milliseconds()
	return out, nil
}

// encode turns one raw cell into the string the browser gets.
// sql.RawBytes is only valid until the next Next(), so this always copies.
func encode(b sql.RawBytes, binary bool) string {
	if binary {
		if len(b) > MaxCell/2 {
			return hex.EncodeToString(b[:MaxCell/2]) + "…"
		}
		return hex.EncodeToString(b)
	}
	if len(b) > MaxCell {
		return string(b[:MaxCell]) + "…"
	}
	return string(b)
}

// columns reads the result-set header.
func columns(rows *sql.Rows) ([]Column, error) {
	types, e := rows.ColumnTypes()
	if e != nil {
		return nil, fmt.Errorf("meta.columns: %w", e)
	}
	out := make([]Column, 0, len(types))
	for _, t := range types {
		name := strings.ToUpper(t.DatabaseTypeName())
		nullable, ok := t.Nullable()
		out = append(out, Column{
			Name:     t.Name(),
			Type:     name,
			Nullable: nullable && ok,
			Binary:   binaryTypes[name],
		})
	}
	return out, nil
}

// Strings runs a query returning a single text column, e.g. SHOW DATABASES.
func Strings(ctx context.Context, q Querier, query string, args ...any) ([]string, error) {
	rows, e := q.QueryContext(ctx, query, args...)
	if e != nil {
		return nil, fmt.Errorf("meta.Strings: %w", e)
	}
	defer func() {
		if e := rows.Close(); e != nil {
			log.Printf("meta.Strings rows.Close: %s", e)
		}
	}()

	out := make([]string, 0, 16)
	for rows.Next() {
		var s string
		if e := rows.Scan(&s); e != nil {
			return nil, fmt.Errorf("meta.Strings scan: %w", e)
		}
		out = append(out, s)
	}
	if e := rows.Err(); e != nil {
		return nil, fmt.Errorf("meta.Strings rows: %w", e)
	}
	return out, nil
}
