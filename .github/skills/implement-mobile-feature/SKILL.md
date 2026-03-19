---
name: implement-mobile-feature
description: 'Guided mobile feature implementation across all layers of Android (Kotlin/Jetpack Compose) and iOS (Swift/SwiftUI) applications. Creates or modifies screens, ViewModels, use cases, repositories, data sources, DTOs, navigation routes, and DI modules following MVVM + Clean Architecture patterns. Use when asked to implement a feature, fix a bug, add a screen, or make code changes in mobile projects.'
---

# Implement Mobile Feature

Step-by-step implementation guidance for Android and iOS projects.

## When to Use

- Implementing a new feature or PBI in a mobile app
- Fixing a bug with code changes
- Adding a new screen with navigation
- Modifying existing business logic
- Creating or updating API integrations

## Prerequisites

- Investigation report or clear PBI requirements
- Understanding of affected features/modules

## Workflow

### Step 1: Detect Platform & Analyze Patterns

Detect whether this is Android, iOS, or KMP:
- **Android**: `build.gradle.kts`, `AndroidManifest.xml`, Kotlin source files
- **iOS**: `*.xcodeproj`, `Package.swift`, Swift source files
- **KMP**: `shared/` module with `commonMain`

Then analyze existing patterns:
- Architecture pattern (MVVM, MVI, Clean Architecture)
- DI framework (Hilt, Koin, manual injection, Swinject)
- Navigation approach (Compose Navigation, Coordinator, Router)
- State management (StateFlow, LiveData, @Observable, Combine)
- Networking (Retrofit, Ktor, URLSession, Alamofire)
- Local storage (Room, DataStore, CoreData, SwiftData)
- Testing approach (JUnit/MockK, XCTest/Swift Testing)

### Step 2: Plan Implementation

Identify all files to create/modify per layer:

**Android:**
1. DTOs (`data/remote/dto/`)
2. Room Entity + DAO (`data/local/`)
3. API Service interface (`data/remote/`)
4. Repository implementation (`data/repository/`)
5. Domain model (`domain/model/`)
6. Repository interface (`domain/repository/`)
7. Use Case (`domain/usecase/`)
8. UI State sealed interface (`presentation/`)
9. ViewModel (`presentation/`)
10. Composable screens (`presentation/`)
11. Navigation route (`navigation/`)
12. Hilt Module (`di/`)

**iOS:**
1. DTOs (`Data/DTOs/`)
2. SwiftData/CoreData model (`Data/`)
3. API Service (`Data/`)
4. Repository implementation (`Data/`)
5. Domain model (`Domain/`)
6. Repository protocol (`Domain/`)
7. Use Case (`Domain/`)
8. ViewState enum (`Presentation/`)
9. ViewModel (`Presentation/`)
10. SwiftUI Views (`Presentation/`)
11. Navigation route (`Navigation/`)

### Step 3: Implement (bottom-up)

**Order of implementation:** Data Layer → Domain Layer → Presentation Layer → Navigation → DI

#### Data Layer
- Create DTOs matching API response
- Create local entities (Room @Entity / @Model)
- Create DAO/data access interface
- Create API service interface
- Implement repository (offline-first pattern)

#### Domain Layer
- Create domain models (clean, platform-independent)
- Define repository interface/protocol
- Create use cases for each business operation

#### Presentation Layer
- Define UI State (sealed interface/enum)
- Create ViewModel with StateFlow/@Observable
- Create screens/views (stateless composables/views)
- Create stateful container connecting ViewModel

#### Navigation & DI
- Add navigation routes
- Register dependencies in DI module

### Step 4: Write Tests

For each new/modified class:
- Create fake repositories for ViewModel tests
- Create test builders for domain models and DTOs
- Test all UI states (Loading, Content, Error, Empty)
- Test all business logic branches in use cases
- Test error handling and edge cases

### Step 5: Verify

**Android:**
```bash
./gradlew assembleDebug        # compilation check
./gradlew testDebugUnitTest    # unit tests
./gradlew lint                 # lint checks
```

**iOS:**
```bash
xcodebuild test -scheme MyApp -destination 'platform=iOS Simulator,name=iPhone 16'
swift build                    # SPM compilation check
```

## Validation Checklist

- [ ] All layers follow existing codebase patterns
- [ ] UI State handles Loading, Content, Error, and Empty states
- [ ] ViewModel uses StateFlow (Android) or @Observable (iOS)
- [ ] Repository has interface/protocol for testability
- [ ] DI is properly configured
- [ ] Navigation is integrated
- [ ] Unit tests cover all business logic branches
- [ ] Accessibility attributes added (contentDescription / accessibilityLabel)
- [ ] Strings are localized (strings.xml / Localizable.strings)
- [ ] No compilation errors or warnings
