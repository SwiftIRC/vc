package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/SwiftIRC/coyote/internal/config"
	"github.com/SwiftIRC/coyote/internal/room"
	"github.com/SwiftIRC/coyote/internal/server"
	"github.com/SwiftIRC/coyote/internal/sfu"
)

func main() {
	cfg, err := config.Load(os.Args[1:], os.Getenv)
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(2)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	reg := room.NewRegistry(cfg.AdhocRooms, time.Now)
	engine, err := sfu.NewEngine(cfg)
	if err != nil {
		slog.Error("sfu engine", "err", err)
		os.Exit(2)
	}
	mediaSFU := sfu.NewSFU(engine, log)
	hub := server.NewHub(cfg, reg, log, time.Now, mediaSFU)
	srv := &http.Server{Addr: cfg.Addr, Handler: hub.Routes()}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go hub.RunGC(ctx)
	go func() {
		<-ctx.Done()
		hub.Shutdown()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()

	log.Info("listening", "addr", cfg.Addr, "adhoc", cfg.AdhocRooms, "tokens", cfg.Secret != "",
		"publicIP", cfg.PublicIP, "udp", fmt.Sprintf("%d-%d", cfg.UDPPortMin, cfg.UDPPortMax))
	if cfg.PublicIP == "" {
		log.Warn("no -public-ip set: the SFU will advertise only its local interface addresses, " +
			"so browsers on other hosts (e.g. behind a reverse proxy) will get no media (black video). " +
			"Set -public-ip to the address clients reach, and open the -udp-min..-udp-max range in the firewall.")
	}
	if cfg.TLSCert != "" {
		err = srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
}
