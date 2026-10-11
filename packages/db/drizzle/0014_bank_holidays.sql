CREATE TABLE "bank_holiday" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"nation" text NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "bank_holiday_nation_date" UNIQUE("nation","date")
);
