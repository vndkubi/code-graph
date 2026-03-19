---
description: 'Maven POM conventions, dependency management, and plugin configuration standards.'
applyTo: '**/pom.xml'
---

# Maven POM Conventions

## Dependency Version Management

```xml
<!-- ✅ Use properties for version management -->
<properties>
    <java.version>17</java.version>
    <jakarta.ee.version>10.0.0</jakarta.ee.version>
    <junit.version>5.10.2</junit.version>
    <mockito.version>5.11.0</mockito.version>
    <assertj.version>3.25.3</assertj.version>
    <wiremock.version>3.5.4</wiremock.version>
</properties>

<!-- ✅ BOM imports in dependencyManagement -->
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>jakarta.platform</groupId>
            <artifactId>jakarta.jakartaee-bom</artifactId>
            <version>${jakarta.ee.version}</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<!-- ✅ No version in child dependencies (inherited from BOM/parent) -->
<dependencies>
    <dependency>
        <groupId>jakarta.persistence</groupId>
        <artifactId>jakarta.persistence-api</artifactId>
        <scope>provided</scope>
        <!-- version inherited from BOM -->
    </dependency>
</dependencies>

<!-- ❌ Avoid hardcoded versions in dependencies -->
<dependency>
    <groupId>org.junit.jupiter</groupId>
    <artifactId>junit-jupiter</artifactId>
    <version>5.10.2</version> <!-- ❌ hardcoded -->
</dependency>
```

## Plugin Management

```xml
<!-- ✅ Plugins in pluginManagement for version control -->
<build>
    <pluginManagement>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-compiler-plugin</artifactId>
                <version>3.13.0</version>
                <configuration>
                    <release>${java.version}</release>
                </configuration>
            </plugin>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-surefire-plugin</artifactId>
                <version>3.2.5</version>
            </plugin>
        </plugins>
    </pluginManagement>
</build>
```

## Profiles

```xml
<!-- ✅ Use profiles for environment-specific configuration -->
<profiles>
    <profile>
        <id>dev</id>
        <activation>
            <activeByDefault>true</activeByDefault>
        </activation>
        <properties>
            <db.url>jdbc:oracle:thin:@localhost:1521:XE</db.url>
        </properties>
    </profile>
    <profile>
        <id>test</id>
        <properties>
            <db.url>jdbc:h2:mem:testdb</db.url>
        </properties>
    </profile>
</profiles>
```

## Multi-Module Projects

```xml
<!-- ✅ Parent POM structure -->
<modules>
    <module>module-api</module>
    <module>module-core</module>
    <module>module-persistence</module>
</modules>

<!-- In child POM: inherit parent, don't redeclare managed dependencies -->
<parent>
    <groupId>com.company</groupId>
    <artifactId>project-parent</artifactId>
    <version>${revision}</version>
</parent>
```

## Test Dependencies

```xml
<!-- ✅ Test dependencies with proper scope -->
<dependency>
    <groupId>org.junit.jupiter</groupId>
    <artifactId>junit-jupiter</artifactId>
    <version>${junit.version}</version>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.assertj</groupId>
    <artifactId>assertj-core</artifactId>
    <version>${assertj.version}</version>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.mockito</groupId>
    <artifactId>mockito-core</artifactId>
    <version>${mockito.version}</version>
    <scope>test</scope>
</dependency>
```
