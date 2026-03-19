from .order_service import OrderService


class OrderController:
    def __init__(self, order_service: OrderService):
        self.order_service = order_service

    def create(self, items: list, customer_id: str) -> dict:
        return self.order_service.create_order(items, customer_id)

    def get(self, order_id: str) -> dict:
        return self.order_service.get_order(order_id)
