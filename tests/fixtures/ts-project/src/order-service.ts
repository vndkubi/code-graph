import { PaymentService } from './payment-service';
import { InventoryService } from './inventory-service';

export class OrderService {
  constructor(
    private paymentService: PaymentService,
    private inventoryService: InventoryService,
  ) {}

  async create(request: { items: string[]; customerId: string }): Promise<{ id: string; status: string }> {
    await this.inventoryService.checkAvailability(request.items);
    await this.paymentService.charge(request.customerId, 100);
    return { id: '1', status: 'created' };
  }

  async findById(id: string): Promise<{ id: string; status: string }> {
    return { id, status: 'found' };
  }
}
