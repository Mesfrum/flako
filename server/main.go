package main

import (
	"log"
	"net/http"

	"github.com/joho/godotenv"

	"github.com/Mesfrum/shribe2e/server/db"
	"github.com/Mesfrum/shribe2e/server/middleware"
	"github.com/Mesfrum/shribe2e/server/routes"
)

func main() {
	err := godotenv.Load()
	if err != nil {
		log.Println("No .env file found, using system env vars")
	}

	// Initialize database connection
	db.InitDB()

	router := routes.SetupRoutes()
	router.Use(middleware.CORS)

	log.Println("Server running on http://localhost:8080")
	err = http.ListenAndServe(":8080", router)
	if err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}
