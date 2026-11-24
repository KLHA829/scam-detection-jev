package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func envOr(key, fallback string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	return v
}

func main() {
	host := envOr("WA_BRIDGE_HOST", "127.0.0.1")
	if !isLoopbackHost(host) {
		log.Fatalf("wa-bridge refuses non-loopback host %q (must be 127.0.0.1, localhost, or ::1)", host)
	}
	token := strings.TrimSpace(os.Getenv("WA_BRIDGE_TOKEN"))
	if token == "" {
		log.Fatalf("WA_BRIDGE_TOKEN is required so local processes cannot access the paired WhatsApp session")
	}
	port := envOr("WA_BRIDGE_PORT", "8767")
	dbPath := envOr("WA_BRIDGE_DB_PATH", "wa-bridge.db")
	logLevel := strings.ToUpper(envOr("WA_BRIDGE_LOG_LEVEL", "WARN"))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	bridge, err := NewWhatsmeowBridge(ctx, dbPath, logLevel)
	if err != nil {
		log.Fatalf("init wa-bridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	addr := net.JoinHostPort(normalizeBindHost(host), port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}

	srv := &http.Server{
		Handler:           NewBridgeHandler(bridge, token),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		fmt.Printf("[INFO] wa-bridge listening on http://%s\n", ln.Addr().String())
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	if err := bridge.Start(ctx); err != nil {
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = srv.Shutdown(shutCtx)
		cancel()
		log.Fatalf("start wa-bridge: %v", err)
	}

	select {
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	case err := <-errCh:
		if err != nil {
			log.Fatalf("wa-bridge server error: %v", err)
		}
	}
}
