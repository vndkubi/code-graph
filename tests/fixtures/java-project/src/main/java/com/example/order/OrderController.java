package com.example.order;

import com.example.order.OrderService;
import java.util.List;
import javax.ws.rs.GET;
import javax.ws.rs.POST;
import javax.ws.rs.Path;

@Path("/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @POST
    public OrderDto create(CreateOrderRequest request) {
        return orderService.createOrder(request);
    }

    @GET
    @Path("/{id}")
    public OrderDto get(String id) {
        return orderService.getOrder(id);
    }

    @GET
    public List<OrderDto> list() {
        return orderService.listOrders();
    }
}
