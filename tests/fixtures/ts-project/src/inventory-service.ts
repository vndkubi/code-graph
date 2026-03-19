export class InventoryService {
  async checkAvailability(items: string[]): Promise<boolean> {
    return items.length > 0;
  }

  async reserve(items: string[]): Promise<void> {
    console.log(`Reserving ${items.length} items`);
  }
}
