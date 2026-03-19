from .payment_service import PaymentService
from .inventory_service import InventoryService


class OrderService:
    def __init__(self, payment_service: PaymentService, inventory_service: InventoryService):
        self.payment_service = payment_service
        self.inventory_service = inventory_service

    def create_order(self, items: list, customer_id: str) -> dict:
        self.inventory_service.check_availability(items)
        self.payment_service.charge(customer_id, 100)
        return {"id": "1", "status": "created"}

    def get_order(self, order_id: str) -> dict:
        return {"id": order_id, "status": "found"}
