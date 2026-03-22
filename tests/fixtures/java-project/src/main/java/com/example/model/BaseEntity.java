package com.example.model;

import com.fasterxml.jackson.annotation.JsonProperty;

public abstract class BaseEntity {
    @JsonProperty
    private Long id;
    private String name;
    private String createdBy;
}
