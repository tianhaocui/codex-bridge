plugins {
    kotlin("jvm") version "2.1.10"
    id("org.jetbrains.intellij") version "1.17.4"
}

group = "com.codexbridge"
version = "0.1.1"

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.1")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

intellij {
    localPath.set("$projectDir/.intellij-local")
    downloadSources.set(false)
    plugins.set(emptyList())
}

tasks {
    patchPluginXml {
        sinceBuild.set("251")
        untilBuild.set("251.*")
    }

    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        kotlinOptions.jvmTarget = "17"
    }

    withType<JavaCompile> {
        sourceCompatibility = "17"
        targetCompatibility = "17"
    }

    named("buildSearchableOptions") {
        enabled = false
    }
}
