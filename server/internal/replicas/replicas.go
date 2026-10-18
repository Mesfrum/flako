// Package replicas finds the newest per-boot Litestream replica in an S3-compatible bucket.
//
// Each container boot replicates to its own path, flako/<boot id>/notes.db, where the boot id is
// a UTC timestamp plus a random suffix ("20261019T120000Z-0a1b"), so lexical order = boot order.
// Two instances running side by side during a deploy then never write into the same replica.
// On boot, the entrypoint asks Newest for the latest boot id and restores from that path.
//
// This is deliberately tiny and stdlib-only: one signed ListObjectsV2 request (AWS SigV4), no SDK.
package replicas

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Prefix is the bucket prefix under which every boot's replica lives.
const Prefix = "flako/"

var bootID = regexp.MustCompile(`^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+$`)

// IsBootID reports whether s is a boot id as written by docker/entrypoint.sh.
func IsBootID(s string) bool { return bootID.MatchString(s) }

// Config locates the bucket. Endpoint is the S3 base URL (path-style: Endpoint/Bucket).
type Config struct {
	Endpoint, Bucket, AccessKey, SecretKey, Region string
}

type listResult struct {
	CommonPrefixes []struct {
		Prefix string `xml:"Prefix"`
	} `xml:"CommonPrefixes"`
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
}

// Newest returns the latest boot id that has at least one object under flako/<id>/, or "" if
// there is none. Any network, auth or parse error is returned (the caller treats it as a failed
// restore, never as "no backup").
func Newest(ctx context.Context, c *http.Client, cfg Config) (string, error) {
	var ids []string
	token := ""
	for page := 0; page < 100; page++ { // 100 pages x 1000 prefixes: far more boots than retention keeps
		q := url.Values{"list-type": {"2"}, "prefix": {Prefix}, "delimiter": {"/"}}
		if token != "" {
			q.Set("continuation-token", token)
		}
		u := strings.TrimRight(cfg.Endpoint, "/") + "/" + cfg.Bucket + "?" + q.Encode()
		req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
		if err != nil {
			return "", err
		}
		sign(req, cfg.AccessKey, cfg.SecretKey, cfg.Region, time.Now().UTC())
		resp, err := c.Do(req)
		if err != nil {
			return "", err
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		if err != nil {
			return "", err
		}
		if resp.StatusCode != http.StatusOK {
			return "", fmt.Errorf("list %s: HTTP %d: %.200s", Prefix, resp.StatusCode, body)
		}
		var res listResult
		if err := xml.Unmarshal(body, &res); err != nil {
			return "", fmt.Errorf("list %s: %w", Prefix, err)
		}
		for _, p := range res.CommonPrefixes {
			id := strings.TrimSuffix(strings.TrimPrefix(p.Prefix, Prefix), "/")
			if IsBootID(id) {
				ids = append(ids, id)
			}
		}
		if !res.IsTruncated {
			if len(ids) == 0 {
				return "", nil
			}
			sort.Strings(ids)
			return ids[len(ids)-1], nil
		}
		if res.NextContinuationToken == "" {
			return "", fmt.Errorf("list %s: truncated without a continuation token", Prefix)
		}
		token = res.NextContinuationToken
	}
	return "", fmt.Errorf("list %s: too many pages", Prefix)
}

// emptySHA256 is the hash of an empty body; GET requests sign it as their payload hash.
const emptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// sign adds AWS Signature Version 4 headers (service "s3") to a body-less request.
func sign(req *http.Request, accessKey, secretKey, region string, at time.Time) {
	amzDate := at.Format("20060102T150405Z")
	day := at.Format("20060102")
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", emptySHA256)

	host := req.URL.Host
	canonicalHeaders := "host:" + host + "\n" +
		"x-amz-content-sha256:" + emptySHA256 + "\n" +
		"x-amz-date:" + amzDate + "\n"
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"

	path := req.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	canonicalRequest := strings.Join([]string{
		req.Method, path, canonicalQuery(req.URL.Query()), canonicalHeaders, signedHeaders, emptySHA256,
	}, "\n")

	scope := day + "/" + region + "/s3/aws4_request"
	stringToSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hexSHA256(canonicalRequest)

	key := hmacSHA256([]byte("AWS4"+secretKey), day)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(key, stringToSign))

	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+accessKey+"/"+scope+
		",SignedHeaders="+signedHeaders+",Signature="+sig)
}

// canonicalQuery sorts parameters by name and percent-encodes them per RFC 3986 (SigV4 rules).
func canonicalQuery(v url.Values) string {
	keys := make([]string, 0, len(v))
	for k := range v {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vals := append([]string(nil), v[k]...)
		sort.Strings(vals)
		for _, val := range vals {
			parts = append(parts, uriEncode(k)+"="+uriEncode(val))
		}
	}
	return strings.Join(parts, "&")
}

// uriEncode escapes everything except A-Z a-z 0-9 - _ . ~ (so "/" becomes %2F, " " becomes %20).
func uriEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if ('A' <= c && c <= 'Z') || ('a' <= c && c <= 'z') || ('0' <= c && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func hexSHA256(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}
