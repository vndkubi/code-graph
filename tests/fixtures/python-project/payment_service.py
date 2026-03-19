class PaymentService:
    def charge(self, customer_id: str, amount: float) -> None:
        print(f"Charging {customer_id} ${amount}")

    def refund(self, transaction_id: str) -> None:
        print(f"Refunding {transaction_id}")
