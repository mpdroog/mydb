package erm

import (
	"sort"
	"strconv"
	"strings"
)

// hubDegree is how many distinct neighbours make a table a hub.
//
// A `users` table that half the schema points at is not part of any one
// cluster; leaving it in the graph merges every island into a single blob
// and the grouping stops saying anything. Pulling it out first is what
// makes the components meaningful.
const hubDegree = 8

// GroupKind says why a set of tables belongs together.
type GroupKind string

// The kinds of grouping, in the order they are applied.
const (
	// GroupComponent is a set of tables that reach each other through links.
	GroupComponent GroupKind = "component"
	// GroupPrefix is unlinked tables that share a name prefix, which is how
	// schemas without foreign keys usually signal that things belong together.
	GroupPrefix GroupKind = "prefix"
	// GroupHub is the heavily-referenced tables held out of the components.
	GroupHub GroupKind = "hub"
	// GroupIsolated is everything left over.
	GroupIsolated GroupKind = "isolated"
)

// Group is one cluster in the diagram.
type Group struct {
	Name   string    `json:"name"`
	Kind   GroupKind `json:"kind"`
	Tables []string  `json:"tables"`
}

// Cluster groups the tables so the diagram reads as a few related islands
// rather than one graph.
//
func Cluster(tables []Table, links []Link) []Group {
	names := make([]string, 0, len(tables))
	exists := make(map[string]bool, len(tables))
	for _, t := range tables {
		names = append(names, t.Name)
		exists[t.Name] = true
	}
	sort.Strings(names)

	neighbours := adjacency(links, exists)

	// 1. Hold the hubs out before looking for components, or a `users`
	// table joined by half the schema merges every island into one blob.
	hubs := map[string]bool{}
	for name, n := range neighbours {
		if len(n) >= hubDegree {
			hubs[name] = true
		}
	}

	// 2. Components over everything that is left. A component of one is
	// not a group; it goes back in the pool rather than disappearing.
	var (
		groups []Group
		loose  []string
		seen   = map[string]bool{}
	)
	for _, name := range names {
		if hubs[name] || seen[name] {
			continue
		}
		part := walk(name, neighbours, hubs, seen)
		if len(part) < 2 {
			loose = append(loose, part...)
			continue
		}
		sort.Strings(part)
		groups = append(groups, Group{
			Name:   componentName(part),
			Kind:   GroupComponent,
			Tables: part,
		})
	}

	// 3. A table left over that hangs off a hub belongs with that hub.
	// Holding the hub out was a layout decision, not a claim that its
	// satellites are unrelated -- calling those eight tables "unrelated"
	// would throw away the only thing known about them.
	loose = attachToHubs(loose, hubs, neighbours, &groups)

	// 4. Then a shared name prefix, which is how a schema without foreign
	// keys usually says these belong together.
	prefixed, rest := byPrefix(loose)
	groups = append(groups, prefixed...)

	if len(rest) > 0 {
		sort.Strings(rest)
		groups = append(groups, Group{Name: "unrelated", Kind: GroupIsolated, Tables: rest})
	}
	return groups
}

// attachToHubs puts each leftover table with the hub it links to most,
// returning whatever still has no hub. One group is emitted per hub, named
// for it, so the diagram can draw the hub once with short stubs instead of
// edges crossing the whole page.
func attachToHubs(loose []string, hubs map[string]bool, neighbours map[string]map[string]bool, groups *[]Group) []string {
	if len(hubs) == 0 {
		return loose
	}

	members := map[string][]string{}
	var rest []string
	for _, name := range loose {
		best := ""
		for n := range neighbours[name] {
			// Ties break on name so the grouping is stable run to run.
			if hubs[n] && (best == "" || n < best) {
				best = n
			}
		}
		if best == "" {
			rest = append(rest, name)
			continue
		}
		members[best] = append(members[best], name)
	}

	names := make([]string, 0, len(hubs))
	for h := range hubs {
		names = append(names, h)
	}
	sort.Strings(names)

	for _, h := range names {
		part := append([]string{h}, members[h]...)
		sort.Strings(part)
		*groups = append(*groups, Group{
			Name:   componentName2(h, len(members[h])),
			Kind:   GroupHub,
			Tables: part,
		})
	}
	return rest
}

// componentName2 names a hub group after the hub itself.
func componentName2(hub string, satellites int) string {
	if satellites == 0 {
		return hub
	}
	return hub + " +" + strconv.Itoa(satellites)
}

// adjacency builds the undirected neighbour map, ignoring self-links and
// links that point outside the schema.
func adjacency(links []Link, exists map[string]bool) map[string]map[string]bool {
	out := map[string]map[string]bool{}
	add := func(a, b string) {
		if out[a] == nil {
			out[a] = map[string]bool{}
		}
		out[a][b] = true
	}
	for _, l := range links {
		if l.From == l.To || !exists[l.From] || !exists[l.To] {
			continue
		}
		add(l.From, l.To)
		add(l.To, l.From)
	}
	return out
}

// walk collects one connected component, never crossing a hub.
func walk(start string, neighbours map[string]map[string]bool, hubs, seen map[string]bool) []string {
	var (
		out   []string
		stack = []string{start}
	)
	seen[start] = true

	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		out = append(out, cur)

		next := make([]string, 0, len(neighbours[cur]))
		for n := range neighbours[cur] {
			next = append(next, n)
		}
		sort.Strings(next)
		for _, n := range next {
			if seen[n] || hubs[n] {
				continue
			}
			seen[n] = true
			stack = append(stack, n)
		}
	}
	return out
}

// componentName labels a component by its largest-looking member, so the
// group reads as "orders +6" rather than as a number.
func componentName(part []string) string {
	best := part[0]
	for _, n := range part {
		if len(n) < len(best) {
			best = n
		}
	}
	if len(part) == 1 {
		return best
	}
	return best + " +" + strconv.Itoa(len(part)-1)
}

// minPrefixGroup is how many tables must share a prefix before it counts
// as a deliberate naming convention rather than a coincidence.
const minPrefixGroup = 2

// byPrefix groups leftover tables that share a name prefix, which is how a
// schema without foreign keys usually says these belong together.
func byPrefix(loose []string) (groups []Group, rest []string) {
	buckets := map[string][]string{}
	for _, name := range loose {
		p := prefixOf(name)
		if p == "" {
			rest = append(rest, name)
			continue
		}
		buckets[p] = append(buckets[p], name)
	}

	keys := make([]string, 0, len(buckets))
	for p := range buckets {
		keys = append(keys, p)
	}
	sort.Strings(keys)

	for _, p := range keys {
		if len(buckets[p]) < minPrefixGroup {
			rest = append(rest, buckets[p]...)
			continue
		}
		sort.Strings(buckets[p])
		groups = append(groups, Group{Name: p + "_*", Kind: GroupPrefix, Tables: buckets[p]})
	}
	sort.Strings(rest)
	return groups, rest
}

// prefixOf returns the part before the first underscore, "" when there is
// none or when it is too short to mean anything.
func prefixOf(name string) string {
	i := strings.Index(name, "_")
	if i < 2 {
		return ""
	}
	return strings.ToLower(name[:i])
}
