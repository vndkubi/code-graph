import { OrderService } from './order-service';
import { PaymentService } from './payment-service';

export class OrderController {
  private orderService: OrderService;

  constructor(orderService: OrderService) {
    this.orderService = orderService;
  }

  async createOrder(request: CreateOrderRequest): Promise<OrderDto> {
    return this.orderService.create(request);
  }

  async getOrder(id: string): Promise<OrderDto> {
    return this.orderService.findById(id);
  }
}

export interface CreateOrderRequest {
  items: string[];
  customerId: string;
}

export interface OrderDto {
  id: string;
  status: string;
}
