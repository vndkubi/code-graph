---
description: 'Gradle and Gradle Kotlin DSL conventions for Android and Kotlin projects. Dependency management, version catalogs, plugin configuration, build variants, and multi-module setup.'
applyTo: '**/*.gradle.kts'
---

# Gradle Build Conventions

## Version Catalog (libs.versions.toml)

```toml
# ✅ Centralize all versions in gradle/libs.versions.toml
[versions]
kotlin = "2.0.21"
agp = "8.7.3"
compose-bom = "2024.12.01"
hilt = "2.53.1"
room = "2.6.1"
retrofit = "2.11.0"
coroutines = "1.9.0"
lifecycle = "2.8.7"

[libraries]
# AndroidX
androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version = "1.15.0" }
androidx-lifecycle-runtime = { group = "androidx.lifecycle", name = "lifecycle-runtime-compose", version.ref = "lifecycle" }
androidx-lifecycle-viewmodel = { group = "androidx.lifecycle", name = "lifecycle-viewmodel-compose", version.ref = "lifecycle" }

# Compose BOM
compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "compose-bom" }
compose-ui = { group = "androidx.compose.ui", name = "ui" }
compose-material3 = { group = "androidx.compose.material3", name = "material3" }

# Networking
retrofit = { group = "com.squareup.retrofit2", name = "retrofit", version.ref = "retrofit" }
retrofit-moshi = { group = "com.squareup.retrofit2", name = "converter-moshi", version.ref = "retrofit" }

# Room
room-runtime = { group = "androidx.room", name = "room-runtime", version.ref = "room" }
room-compiler = { group = "androidx.room", name = "room-compiler", version.ref = "room" }
room-ktx = { group = "androidx.room", name = "room-ktx", version.ref = "room" }

# DI
hilt-android = { group = "com.google.dagger", name = "hilt-android", version.ref = "hilt" }
hilt-compiler = { group = "com.google.dagger", name = "hilt-compiler", version.ref = "hilt" }

# Testing
junit = { group = "junit", name = "junit", version = "4.13.2" }
junit5 = { group = "org.junit.jupiter", name = "junit-jupiter", version = "5.11.4" }
mockk = { group = "io.mockk", name = "mockk", version = "1.13.13" }
turbine = { group = "app.cash.turbine", name = "turbine", version = "1.2.0" }
coroutines-test = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-test", version.ref = "coroutines" }

[bundles]
compose = ["compose-ui", "compose-material3"]
room = ["room-runtime", "room-ktx"]
networking = ["retrofit", "retrofit-moshi"]

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
android-library = { id = "com.android.library", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
hilt = { id = "com.google.dagger.hilt.android", version.ref = "hilt" }
ksp = { id = "com.google.devtools.ksp", version = "2.0.21-1.0.28" }
```

## Root build.gradle.kts

```kotlin
// ✅ Root build file — plugin aliases only
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.hilt) apply false
    alias(libs.plugins.ksp) apply false
}
```

## App Module build.gradle.kts

```kotlin
// ✅ App module with version catalog references
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.company.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.company.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // ✅ Use version catalog aliases
    implementation(libs.bundles.compose)
    implementation(libs.bundles.networking)
    implementation(libs.bundles.room)
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    ksp(libs.room.compiler)

    // ✅ Testing
    testImplementation(libs.junit5)
    testImplementation(libs.mockk)
    testImplementation(libs.turbine)
    testImplementation(libs.coroutines.test)
}
```

## Library Module build.gradle.kts

```kotlin
// ✅ Feature module as library
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.company.app.feature.orders"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
    }
}

dependencies {
    implementation(project(":core:common"))
    implementation(project(":core:network"))
    // ...
}
```

## Multi-Module Structure

```
// ✅ settings.gradle.kts
rootProject.name = "my-app"

include(":app")
include(":core:common")
include(":core:network")
include(":core:database")
include(":core:ui")
include(":feature:orders")
include(":feature:customers")
include(":feature:payments")
```

## Guidelines

- **ALWAYS** use version catalog (`libs.versions.toml`) — no hardcoded versions in build files
- Use `alias(libs.plugins.xxx)` for plugins, `libs.xxx` for dependencies
- Use `bundles` to group related dependencies
- Use Kotlin DSL (`.gradle.kts`) — not Groovy
- Feature modules should be `com.android.library`, not `application`
- Feature modules should NOT depend on each other — communicate via `:core` modules
- Use `ksp` instead of `kapt` for annotation processing
- Set `isMinifyEnabled = true` for release builds
- Use `buildConfigField` for environment-specific values
- Keep `compileSdk` and `targetSdk` at latest stable
- Use `compileOptions` with Java 17
