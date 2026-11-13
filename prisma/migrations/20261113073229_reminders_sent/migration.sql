-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "daysBefore" INTEGER NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reminder_sentAt_idx" ON "Reminder"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Reminder_claimId_daysBefore_key" ON "Reminder"("claimId", "daysBefore");

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
