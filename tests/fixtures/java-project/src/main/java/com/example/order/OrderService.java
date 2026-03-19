package com.example.order;

import com.example.payment.PaymentService;
import com.example.inventory.InventoryService;
import java.util.List;

public class OrderService {

    private final PaymentService paymentService;
    private final InventoryService inventoryService;

    public OrderService(PaymentService paymentService, InventoryService inventoryService) {
        this.paymentService = paymentService;
        this.inventoryService = inventoryService;
    }

    public OrderDto createOrder(CreateOrderRequest request) {
        inventoryService.checkAvailability(request.getItems());
        paymentService.charge(request.getPaymentInfo());
        return new OrderDto(request.getOrderId(), "CREATED");
    }

    public OrderDto getOrder(String orderId) {
        return new OrderDto(orderId, "FOUND");
    }

    public List<OrderDto> listOrders() {
        return List.of();
    }
}
