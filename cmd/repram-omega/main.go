// Command repram-omega is the operator tool for REPRAM's signed-root-list
// trust anchor. It runs offline — never on a REPRAM node. See
// docs/internal/REPRAM-2.1-Spec.md and docs/omega-operations.md.
//
// Subcommands:
//
//	keygen  generate a new Ed25519 omega keypair
//	sign    sign a root list for publication as a DNS TXT record
//
// The omega private key must be stored on an air-gapped signing machine.
// Never transmit it over any network.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"repram/internal/trust"
)

func main() {
	if len(os.Args) < 2 {
		usage(os.Stderr)
		os.Exit(2)
	}

	switch os.Args[1] {
	case "keygen":
		if err := runKeygen(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "keygen: %v\n", err)
			os.Exit(1)
		}
	case "sign":
		if err := runSign(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "sign: %v\n", err)
			os.Exit(1)
		}
	case "-h", "--help", "help":
		usage(os.Stdout)
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand: %s\n\n", os.Args[1])
		usage(os.Stderr)
		os.Exit(2)
	}
}

func usage(w *os.File) {
	fmt.Fprintln(w, "repram-omega — operator tool for REPRAM signed root lists")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  repram-omega keygen --out-private <path> --out-public <path>")
	fmt.Fprintln(w, "  repram-omega sign --key <path> --version <id> --expires-in <seconds> --nodes <csv>")
}

func runKeygen(args []string) error {
	fs := flag.NewFlagSet("keygen", flag.ContinueOnError)
	outPriv := fs.String("out-private", "", "path to write the Ed25519 private key (required)")
	outPub := fs.String("out-public", "", "path to write the Ed25519 public key (required)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *outPriv == "" || *outPub == "" {
		fs.Usage()
		return fmt.Errorf("both --out-private and --out-public are required")
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("generate keypair: %w", err)
	}

	pubB64 := base64.StdEncoding.EncodeToString(pub)
	privB64 := base64.StdEncoding.EncodeToString(priv)

	if err := writeFileMode(*outPriv, []byte(privB64+"\n"), 0o600); err != nil {
		return fmt.Errorf("write private key: %w", err)
	}
	if err := writeFileMode(*outPub, []byte(pubB64+"\n"), 0o644); err != nil {
		return fmt.Errorf("write public key: %w", err)
	}

	fmt.Println("Generated Ed25519 keypair.")
	fmt.Printf("Public key: %s\n", pubB64)
	fmt.Printf("Private key written to %s (mode 0600)\n", *outPriv)
	fmt.Printf("Public key written to %s\n", *outPub)
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Println("  1. Bake the public key into internal/trust/omega.go (OmegaPubkey)")
	fmt.Println("     and repram-mcp/src/node/trust/omega.ts (OMEGA_PUBKEY).")
	fmt.Printf("  2. Store %s on your offline signing machine.\n", *outPriv)
	fmt.Println("  3. Never transmit the private key over any network.")
	return nil
}

func runSign(args []string) error {
	fs := flag.NewFlagSet("sign", flag.ContinueOnError)
	keyPath := fs.String("key", "", "path to Ed25519 private key file (required)")
	version := fs.String("version", trust.OmegaVersion, "omega version identifier")
	expiresIn := fs.Duration("expires-in", 0, "lifetime of the signed list (e.g. 24h)")
	nodes := fs.String("nodes", "", "comma-separated root node addresses host:gossip-port (required)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *keyPath == "" {
		return fmt.Errorf("--key is required")
	}
	if *expiresIn <= 0 {
		return fmt.Errorf("--expires-in must be positive (e.g. 24h)")
	}
	if strings.TrimSpace(*nodes) == "" {
		return fmt.Errorf("--nodes is required")
	}

	privKeyB64, err := os.ReadFile(*keyPath)
	if err != nil {
		return fmt.Errorf("read key: %w", err)
	}
	priv, err := decodePrivateKey(string(privKeyB64))
	if err != nil {
		return err
	}

	list := &trust.SignedList{
		Version: *version,
		Expires: time.Now().Add(*expiresIn).Unix(),
		Nodes:   splitCSV(*nodes),
	}
	list.Sign(priv)

	fmt.Println(list.Encode())
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "To publish:")
	fmt.Fprintln(os.Stderr, "  1. Paste the line above as the value of the _omega.repram.io TXT record.")
	fmt.Fprintln(os.Stderr, "  2. Verify propagation with: dig TXT _omega.repram.io")
	fmt.Fprintf(os.Stderr, "  3. This record expires at %s UTC.\n",
		time.Unix(list.Expires, 0).UTC().Format(time.RFC3339))
	return nil
}

func decodePrivateKey(raw string) (ed25519.PrivateKey, error) {
	raw = strings.TrimSpace(raw)
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("decode private key: %w", err)
	}
	if len(decoded) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("private key has wrong length: got %d want %d", len(decoded), ed25519.PrivateKeySize)
	}
	return ed25519.PrivateKey(decoded), nil
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := parts[:0]
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// writeFileMode writes data to path atomically(ish) with the given mode. The
// file is truncated if it already exists; callers that want to avoid
// clobbering an existing key should check first.
func writeFileMode(path string, data []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
