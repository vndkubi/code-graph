import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrderService } from './order-service';

test('OrderService.create checks inventory, reserves items, then charges payment', async () => {
  const calls: string[] = [];
  const inventoryService = {
    async checkAvailability(items: string[]): Promise<boolean> {
      calls.push(`check:${items.join(',')}`);
      return true;
    },
    async reserve(items: string[]): Promise<void> {
      calls.push(`reserve:${items.join(',')}`);
    },
  };
  const paymentService = {
    async charge(customerId: string, amount: number): Promise<void> {
      calls.push(`charge:${customerId}:${amount}`);
    },
    async refund(_transactionId: string): Promise<void> {},
  };
  const service = new OrderService(paymentService, inventoryService);

  const result = await service.create({ items: ['sku-1'], customerId: 'cust-1' });

  assert.deepEqual(result, { id: '1', status: 'created' });
  assert.deepEqual(calls, ['check:sku-1', 'reserve:sku-1', 'charge:cust-1:100']);
});
