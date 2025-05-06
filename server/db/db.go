package db

import (
	"context"
	"log"
	"os"

	"github.com/jackc/pgx/v5"
)

var Conn *pgx.Conn

func InitDB() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL not set")
	}

	var err error
	Conn, err = pgx.Connect(context.Background(), databaseURL)
	if err != nil {
		log.Fatal("Unable to connect to database:", err)
	}

	log.Println("Connected to Supabase PostgreSQL")
}
