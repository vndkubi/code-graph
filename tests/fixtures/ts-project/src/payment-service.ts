export class PaymentService {
  async charge(customerId: string, amount: number): Promise<void> {
    console.log(`Charging ${customerId} $${amount}`);
  }

  async refund(transactionId: string): Promise<void> {
    console.log(`Refunding ${transactionId}`);
  }
}
