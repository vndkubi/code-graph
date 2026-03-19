package com.example.payment;

public interface PaymentGateway {
    void processPayment(double amount);
    void processRefund(String transactionId);
}
