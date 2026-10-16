// Package config turns environment variables into a typed Config.
package config

// Config holds everything the server needs to start.
type Config struct {
	Addr   string // listen address, e.g. ":8080"
	DBPath string // path to the SQLite database file
}

// Load reads configuration using getenv (pass os.Getenv in production).
// Unset or empty variables fall back to defaults that work locally.
func Load(getenv func(string) string) Config {
	cfg := Config{Addr: ":8080", DBPath: "./data/notes.db"}
	if v := getenv("ADDR"); v != "" {
		cfg.Addr = v
	}
	if v := getenv("DB_PATH"); v != "" {
		cfg.DBPath = v
	}
	return cfg
}
