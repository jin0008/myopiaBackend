-- CreateTable
CREATE TABLE "axial_length_threshold" (
    "age" INTEGER NOT NULL,
    "sex" "sex" NOT NULL,
    "warn_max" REAL NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "axial_length_threshold_unique" ON "axial_length_threshold" ("age", "sex");
