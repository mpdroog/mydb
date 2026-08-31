// mydb serves a browser GUI for managing MySQL servers on localhost.
//
// It is a single binary: the GUI is embedded, the servers come from a TOML
// file next to it, and anything behind a bastion is reached over an
// in-process SSH tunnel that opens no local port.
package main

import (
	"context"
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/julienschmidt/httprouter"
	"github.com/mpdroog/mydb/api"
	"github.com/mpdroog/mydb/config"
	"github.com/mpdroog/mydb/connman"
	"github.com/mpdroog/mydb/jobs"
	"github.com/mpdroog/mydb/middleware"
	"github.com/mpdroog/mydb/qlog"
)

//go:embed static
var static embed.FS

// writeDeadline is the ceiling for an ordinary response. SSE handlers push
// it further out on every event, which is why http.Server.WriteTimeout is
// left at 0 instead: a global one would cut long-lived streams.
const writeDeadline = 90 * time.Second

// shutdownGrace is how long in-flight requests get on Ctrl-C.
const shutdownGrace = 5 * time.Second

// buildRev is stamped in at link time by build-windows.sh. A binary that has
// been sitting on a server for a month should be able to say what it is.
var buildRev = "dev"

func main() {
	var configPath string
	flag.BoolVar(&config.Verbose, "v", false, "Verbose-mode (log every request)")
	flag.StringVar(&configPath, "c", "./config.toml", "Config-file")
	listen := flag.String("h", "", "HTTP listen-address (overrides config-file)")
	flag.Parse()

	dir, e := os.Getwd()
	if e != nil {
		log.Fatal(e)
	}
	config.CurDir = dir

	if e := config.Open(configPath); e != nil {
		log.Fatal(e)
	}

	addr := config.Listen()
	if *listen != "" {
		addr = *listen
	}

	// The query log is a convenience, not a dependency: if it cannot be
	// opened mydb says so and runs without it rather than refusing to start
	// over a file it only wanted to append to.
	qc := config.QueryLog()
	if e := qlog.Open(qc.Path(), qc.MaxSizeMB, qc.Keep); e != nil {
		log.Printf("WARN main: query log disabled: %s", e)
	} else if p := qlog.Path(); p != "" && config.Verbose {
		log.Printf("main: query log %s", p)
	}

	cm := connman.New()
	jm := jobs.New(cm)
	a := api.New(cm, jm)

	assets, e := fs.Sub(static, "static")
	if e != nil {
		log.Fatal(e)
	}

	router := httprouter.New()
	router.GET("/", redirect)
	router.ServeFiles("/static/*filepath", http.FS(assets))

	router.GET("/api/v1/servers", a.ServerList)
	router.POST("/api/v1/servers", a.ServerAdd)
	router.PUT("/api/v1/servers/:name", a.ServerUpdate)
	router.DELETE("/api/v1/servers/:name", a.ServerDelete)
	router.POST("/api/v1/servers/:name/connect", a.ServerConnect)
	router.POST("/api/v1/servers/:name/disconnect", a.ServerDisconnect)
	router.GET("/api/v1/status/events", a.StatusEvents)

	router.GET("/api/v1/databases", a.Databases)
	router.GET("/api/v1/tables", a.Tables)
	router.GET("/api/v1/structure", a.Structure)
	router.GET("/api/v1/erm", a.ERM)
	router.POST("/api/v1/links", a.LinkAdd)
	router.DELETE("/api/v1/links", a.LinkDelete)

	router.GET("/api/v1/dashboard/events", a.DashEvents)
	router.POST("/api/v1/kill", a.Kill)
	router.GET("/api/v1/qlog", a.QueryLog)
	router.POST("/api/v1/split", a.Split)

	router.POST("/api/v1/query", a.QuerySubmit)
	router.GET("/api/v1/jobs/:id", a.JobResult)
	router.GET("/api/v1/jobs/:id/events", a.JobEvents)
	router.POST("/api/v1/jobs/:id/cancel", a.JobCancel)
	router.DELETE("/api/v1/jobs/:id", a.JobForget)

	router.POST("/api/v1/alter", a.Alter)
	router.POST("/api/v1/row", a.RowInsert)
	router.PATCH("/api/v1/row", a.RowUpdate)

	// Outermost first: log, then prove the request is ours, then set the
	// response deadline, then the security headers everything inherits.
	var h http.Handler = router
	h = middleware.SecurityHeaders(h)
	h = middleware.WriteDeadline(writeDeadline)(h)
	h = middleware.CSRFHeader(h)
	h = middleware.LocalOnly(h)
	h = middleware.HostCheck(h)
	h = middleware.HTTPLog(h)

	t := config.Timeouts()
	srv := &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: t.HTTPReadHdr.D(),
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       t.HTTPIdle.D(),
		// No WriteTimeout: deadlines are set per-request instead, so SSE
		// streams can outlive an ordinary response.
		WriteTimeout: 0,
		ErrorLog:     log.Default(),
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("mydb %s listening on http://%s (config %s)", buildRev, addr, config.Path)
		if e := srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			log.Fatal(e)
		}
	}()

	<-stop
	log.Print("mydb shutting down")

	// End the SSE streams first. They never finish on their own, so
	// Shutdown would otherwise sit out the whole grace period waiting for
	// handlers that are watching a browser which is not going anywhere.
	a.Shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if e := srv.Shutdown(ctx); e != nil {
		log.Printf("main shutdown: %s", e)
	}
	jm.Close()
	cm.Close()
	if e := qlog.Close(); e != nil {
		log.Printf("main qlog.Close: %s", e)
	}
}

// redirect sends / to the GUI. Pointing at the directory rather than
// index.html avoids http.FileServer's own canonical-path redirect on top
// of ours.
func redirect(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	http.Redirect(w, r, "/static/", http.StatusSeeOther)
}
