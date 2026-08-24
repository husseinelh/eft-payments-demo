CREATE TABLE dbo.payments (
    id              NVARCHAR(32)  NOT NULL PRIMARY KEY,
    customerName    NVARCHAR(200) NOT NULL,
    amountCents     BIGINT        NOT NULL CHECK (amountCents > 0),
    accountNumber   NVARCHAR(32)  NOT NULL,
    status          NVARCHAR(20)  NOT NULL
        CHECK (status IN ('Pending', 'Sent', 'Success', 'Failed')),
    createdAt       DATETIME2(3)  NOT NULL,
    processedAt     DATETIME2(3)  NULL
);

CREATE TABLE dbo.payment_history (
    id          BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    paymentId   NVARCHAR(32) NOT NULL,
    oldStatus   NVARCHAR(20) NULL,
    newStatus   NVARCHAR(20) NOT NULL,
    [timestamp] DATETIME2(3) NOT NULL,

    CONSTRAINT FK_payment_history_payments
        FOREIGN KEY (paymentId)
        REFERENCES dbo.payments(id)
);

CREATE INDEX idx_history_payment
ON dbo.payment_history(paymentId);

CREATE INDEX idx_payments_status
ON dbo.payments(status);

CREATE TABLE dbo.counters (
    name  NVARCHAR(100) NOT NULL PRIMARY KEY,
    value BIGINT NOT NULL
);

INSERT INTO dbo.counters (name, value)
VALUES ('itemTraceNumber', 0);