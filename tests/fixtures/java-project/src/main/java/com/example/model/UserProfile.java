package com.example.model;

public class UserProfile {
    private String displayName;
    private int reputationScore;

    public String describeProfileBehavior() {
        return displayName + ":" + reputationScore;
    }

    public String getUserProfile() {
        return describeProfileBehavior();
    }
}
