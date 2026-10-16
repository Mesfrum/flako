package config

import "testing"

func TestLoad(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want Config
	}{
		{
			name: "defaults when nothing is set",
			env:  map[string]string{},
			want: Config{Addr: ":8080", DBPath: "./data/notes.db"},
		},
		{
			name: "env overrides defaults",
			env:  map[string]string{"ADDR": ":9999", "DB_PATH": "/tmp/x.db"},
			want: Config{Addr: ":9999", DBPath: "/tmp/x.db"},
		},
		{
			name: "empty values fall back to defaults",
			env:  map[string]string{"ADDR": "", "DB_PATH": ""},
			want: Config{Addr: ":8080", DBPath: "./data/notes.db"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(key string) string { return tc.env[key] }
			if got := Load(getenv); got != tc.want {
				t.Fatalf("Load() = %+v, want %+v", got, tc.want)
			}
		})
	}
}
