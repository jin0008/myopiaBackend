-- CreateTable
CREATE TABLE "community_answer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "post_id" UUID NOT NULL,
    "hospital_account_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "community_answer_pk" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_community_answer_post" ON "community_answer"("post_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "community_answer_post_account_unique" ON "community_answer"("post_id", "hospital_account_id");

-- AddForeignKey
ALTER TABLE "community_answer" ADD CONSTRAINT "community_answer_post_fk" FOREIGN KEY ("post_id") REFERENCES "community_post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_answer" ADD CONSTRAINT "community_answer_account_fk" FOREIGN KEY ("hospital_account_id") REFERENCES "hospital_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

