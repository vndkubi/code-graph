package com.example.order;

import com.example.order.OrderService;
import java.util.List;

public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    public OrderDto create(CreateOrderRequest request) {
        return orderService.createOrder(request);
    }

    public OrderDto get(String id) {
        return orderService.getOrder(id);
    }

    public List<OrderDto> list() {
        return orderService.listOrders();
    }
}
