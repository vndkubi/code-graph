class InventoryService:
    def check_availability(self, items: list) -> bool:
        return len(items) > 0

    def reserve(self, items: list) -> None:
        print(f"Reserving {len(items)} items")
