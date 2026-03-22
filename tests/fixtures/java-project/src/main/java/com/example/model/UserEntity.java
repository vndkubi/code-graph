package com.example.model;

import com.fasterxml.jackson.annotation.JsonProperty;

public class UserEntity extends BaseEntity {
    private String email;
    // BUG: shadows BaseEntity.name — will cause data loss during Jackson deserialization
    private String name;
}
