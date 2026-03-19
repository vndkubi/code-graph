package com.example.payment;

public class PaymentService {

    private final PaymentGateway paymentGateway;

    public PaymentService(PaymentGateway paymentGateway) {
        this.paymentGateway = paymentGateway;
    }

    public void charge(PaymentInfo paymentInfo) {
        paymentGateway.processPayment(paymentInfo.getAmount());
    }

    public void refund(String transactionId) {
        paymentGateway.processRefund(transactionId);
    }
}
