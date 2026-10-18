package replicas

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Known-answer test from the AWS S3 SigV4 documentation ("Example: GET Bucket (List Objects)",
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html).
func TestSignMatchesAWSExample(t *testing.T) {
	req, _ := http.NewRequest("GET", "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", nil)
	at := time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC)
	sign(req, "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", at)
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
		"SignedHeaders=host;x-amz-content-sha256;x-amz-date," +
		"Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("Authorization\n got %s\nwant %s", got, want)
	}
}

// fakeS3 answers ListObjectsV2 with the given common prefixes, pageSize per page.
func fakeS3(t *testing.T, prefixes []string, pageSize int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.URL.Path != "/bkt" || q.Get("list-type") != "2" || q.Get("prefix") != "flako/" || q.Get("delimiter") != "/" {
			http.Error(w, "bad request "+r.URL.String(), 400)
			return
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=key/") {
			http.Error(w, "unsigned", 403)
			return
		}
		start := 0
		if tok := q.Get("continuation-token"); tok != "" {
			fmt.Sscanf(tok, "p%d", &start)
		}
		end := min(start+pageSize, len(prefixes))
		var b strings.Builder
		b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`)
		for _, p := range prefixes[start:end] {
			fmt.Fprintf(&b, "<CommonPrefixes><Prefix>%s</Prefix></CommonPrefixes>", p)
		}
		if end < len(prefixes) {
			fmt.Fprintf(&b, "<IsTruncated>true</IsTruncated><NextContinuationToken>p%d</NextContinuationToken>", end)
		} else {
			b.WriteString("<IsTruncated>false</IsTruncated>")
		}
		b.WriteString("</ListBucketResult>")
		_, _ = w.Write([]byte(b.String()))
	}))
}

func cfgFor(url string) Config {
	return Config{Endpoint: url, Bucket: "bkt", AccessKey: "key", SecretKey: "secret", Region: "auto"}
}

func TestNewestPicksLatestBootAcrossPages(t *testing.T) {
	srv := fakeS3(t, []string{
		"flako/20261018T090000Z-aaaa/",
		"flako/20261019T120000Z-bbbb/",
		"flako/20261019T120000Z-cccc/", // same second, later suffix: sorts last
		"flako/20261019T080000Z-dddd/",
		"flako/notes.db/", // the old single-path layout is not a boot dir
	}, 2)
	defer srv.Close()
	got, err := Newest(context.Background(), srv.Client(), cfgFor(srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	if got != "20261019T120000Z-cccc" {
		t.Fatalf("got %q", got)
	}
}

func TestNewestEmptyBucket(t *testing.T) {
	srv := fakeS3(t, nil, 10)
	defer srv.Close()
	got, err := Newest(context.Background(), srv.Client(), cfgFor(srv.URL))
	if err != nil || got != "" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestNewestReportsHTTPErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "<Error><Code>AccessDenied</Code></Error>", 403)
	}))
	defer srv.Close()
	if _, err := Newest(context.Background(), srv.Client(), cfgFor(srv.URL)); err == nil {
		t.Fatal("want an error for 403")
	}
}

func TestIsBootID(t *testing.T) {
	for id, want := range map[string]bool{
		"20261019T120000Z-0a1b":   true,
		"20261019T120000Z":        false,
		"notes.db":                false,
		"20261019T120000Z-0a1b/x": false,
	} {
		if IsBootID(id) != want {
			t.Errorf("IsBootID(%q) = %v", id, !want)
		}
	}
}
