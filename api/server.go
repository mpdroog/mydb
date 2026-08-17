package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/julienschmidt/httprouter"
	"github.com/mpdroog/mydb/config"
	"github.com/mpdroog/mydb/connman"
	"github.com/mpdroog/mydb/writer"
)

// serverView is a server as the browser sees it. The MySQL and SSH
// passwords are deliberately replaced with a has-a-password flag so the
// config-file's cleartext never leaves the process.
type serverView struct {
	SSH     *sshView `json:"ssh,omitempty"`
	Name    string   `json:"name"`
	Host    string   `json:"host"`
	User    string   `json:"user"`
	Port    int      `json:"port"`
	HasPass bool     `json:"has_pass"`
	// Production is what turns the GUI red for this server and what makes
	// a destructive statement ask for its name instead of a click.
	Production bool `json:"production"`
}

// sshView is the tunnel config minus its secrets.
type sshView struct {
	Host       string `json:"host"`
	User       string `json:"user"`
	Key        string `json:"key"`
	Agent      bool   `json:"agent"`
	HasPass    bool   `json:"has_pass"`
	HasPassphr bool   `json:"has_passphrase"`
}

// serverInput is what the add/edit form sends back. An empty password
// means "keep what is already in the config-file".
type serverInput struct {
	SSH        *sshInput `json:"ssh"`
	Name       string    `json:"name"`
	Host       string    `json:"host"`
	User       string    `json:"user"`
	Pass       string    `json:"pass"`
	Port       int       `json:"port"`
	Production bool      `json:"production"`
}

// sshInput is the tunnel half of the add/edit form.
type sshInput struct {
	Host       string `json:"host"`
	User       string `json:"user"`
	Key        string `json:"key"`
	Passphrase string `json:"passphrase"`
	Pass       string `json:"pass"`
	Agent      bool   `json:"agent"`
}

// view strips the secrets off a configured server.
func view(s config.Server) serverView {
	v := serverView{
		Name:       s.Name,
		Host:       s.Host,
		Port:       s.Port,
		User:       s.User,
		HasPass:    s.Pass != "",
		Production: s.Production,
	}
	if s.SSH != nil {
		v.SSH = &sshView{
			Host:       s.SSH.Host,
			User:       s.SSH.User,
			Agent:      s.SSH.Agent,
			Key:        s.SSH.Key,
			HasPass:    s.SSH.Pass != "",
			HasPassphr: s.SSH.Passphrase != "",
		}
	}
	return v
}

// merge folds form input onto the stored server, carrying over any secret
// the form left blank.
func merge(in serverInput, old config.Server, isNew bool) config.Server {
	s := config.Server{
		Name:       in.Name,
		Host:       in.Host,
		Port:       in.Port,
		User:       in.User,
		Pass:       in.Pass,
		Production: in.Production,
	}
	if in.Pass == "" && !isNew {
		s.Pass = old.Pass
	}
	// The form has no TLS field. Carrying it over keeps an edit from
	// quietly dropping a per-server tls setting out of the config-file.
	if !isNew {
		s.TLS = old.TLS
	}
	if in.SSH != nil {
		n := &config.SSH{
			Host:       in.SSH.Host,
			User:       in.SSH.User,
			Agent:      in.SSH.Agent,
			Key:        in.SSH.Key,
			Pass:       in.SSH.Pass,
			Passphrase: in.SSH.Passphrase,
		}
		if !isNew && old.SSH != nil {
			if n.Pass == "" {
				n.Pass = old.SSH.Pass
			}
			if n.Passphrase == "" {
				n.Passphrase = old.SSH.Passphrase
			}
		}
		s.SSH = n
	}
	return s
}

// ServerList answers the sidebar with every configured server and its
// current connection state.
func (a *API) ServerList(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	type row struct {
		serverView
		Status connman.Status `json:"status"`
	}

	status := make(map[string]connman.Status)
	for _, s := range a.Conn.Status() {
		status[s.Name] = s
	}

	servers := config.Servers()
	out := make([]row, 0, len(servers))
	for _, s := range servers {
		out = append(out, row{serverView: view(s), Status: status[s.Name]})
	}

	if e := writer.Encode(w, out); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.ServerList failed encoding", e)
	}
}

// ServerAdd appends a server and rewrites config.toml.
func (a *API) ServerAdd(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	var in serverInput
	if e := writer.Decode(r, &in); e != nil {
		writer.Err(w, http.StatusBadRequest, "api.ServerAdd failed reading body", e)
		return
	}

	if e := config.AddServer(merge(in, config.Server{}, true)); e != nil {
		code := http.StatusBadRequest
		if errors.Is(e, config.ErrDuplicateServer) {
			code = http.StatusConflict
		}
		writer.Err(w, code, "api.ServerAdd failed saving server", e)
		return
	}
	if e := writer.Encode(w, map[string]string{"name": in.Name}); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.ServerAdd failed encoding", e)
	}
}

// ServerUpdate replaces a server and rewrites config.toml.
func (a *API) ServerUpdate(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	name := ps.ByName("name")

	old, e := config.ServerByName(name)
	if e != nil {
		writer.Err(w, http.StatusNotFound, "api.ServerUpdate no such server", e)
		return
	}

	var in serverInput
	if e := writer.Decode(r, &in); e != nil {
		writer.Err(w, http.StatusBadRequest, "api.ServerUpdate failed reading body", e)
		return
	}

	if e := config.UpdateServer(name, merge(in, old, false)); e != nil {
		writer.Err(w, http.StatusBadRequest, "api.ServerUpdate failed saving server", e)
		return
	}
	// The tunnel now points at stale settings, drop it.
	a.Conn.Disconnect(name)

	if e := writer.Encode(w, map[string]string{"name": in.Name}); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.ServerUpdate failed encoding", e)
	}
}

// ServerDelete removes a server and rewrites config.toml.
func (a *API) ServerDelete(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	name := ps.ByName("name")
	a.Conn.Disconnect(name)

	if e := config.DeleteServer(name); e != nil {
		writer.Err(w, http.StatusNotFound, "api.ServerDelete failed removing server", e)
		return
	}
	if e := writer.Encode(w, map[string]bool{"ok": true}); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.ServerDelete failed encoding", e)
	}
}

// ServerConnect starts a dial in the background and answers straight away,
// so a sidebar click paints "connecting" without waiting on the network.
func (a *API) ServerConnect(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	if e := a.Conn.Connect(ps.ByName("name")); e != nil {
		writer.Err(w, http.StatusNotFound, "api.ServerConnect no such server", e)
		return
	}
	if e := writer.EncodeCode(w, http.StatusAccepted, map[string]bool{"ok": true}); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.ServerConnect failed encoding", e)
	}
}

// ServerDisconnect tears the pool and tunnel down now.
func (a *API) ServerDisconnect(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	a.Conn.Disconnect(ps.ByName("name"))
	if e := writer.Encode(w, map[string]bool{"ok": true}); e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.ServerDisconnect failed encoding", e)
	}
}

// StatusEvents streams every connection state change, which is what drives
// the sidebar dots without any polling.
func (a *API) StatusEvents(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	s, e := newSSE(w)
	if e != nil {
		writer.Err(w, http.StatusInternalServerError, "api.StatusEvents failed opening stream", e)
		return
	}

	ch, unsub := a.Conn.Bus.Subscribe()
	defer unsub()

	// Send the current picture first so a fresh page is never blank.
	for _, st := range a.Conn.Status() {
		if e := s.send(st); e != nil {
			closeStream("StatusEvents", e)
			return
		}
	}

	tick := time.NewTicker(heartbeat)
	defer tick.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case st, ok := <-ch:
			if !ok {
				return
			}
			if e := s.send(st); e != nil {
				closeStream("StatusEvents", e)
				return
			}
		case <-tick.C:
			if e := s.ping(); e != nil {
				closeStream("StatusEvents", e)
				return
			}
		}
	}
}
