import org.gradle.jvm.toolchain.JavaToolchainService
import org.gradle.api.tasks.JavaExec
import org.gradle.api.tasks.SourceSetContainer

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
    testImplementation(kotlin("test"))
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

val javaToolchainService = project.extensions.getByType(JavaToolchainService::class.java)
val sourceSets = project.extensions.getByType(SourceSetContainer::class.java)

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

    withType<Test> {
        javaLauncher.set(
            javaToolchainService.launcherFor {
                languageVersion.set(JavaLanguageVersion.of(17))
            }
        )
    }

    named("buildSearchableOptions") {
        enabled = false
    }

    test {
        useJUnitPlatform()
    }

    register<JavaExec>("runRemoteSupportChecks") {
        group = "verification"
        description = "Run pure Kotlin remote bridge checks without depending on the IntelliJ test runtime."
        dependsOn("testClasses")
        classpath = sourceSets.getByName("test").runtimeClasspath
        mainClass.set("com.codexbridge.idea.RemoteBridgeSupportChecks")
        javaLauncher.set(
            javaToolchainService.launcherFor {
                languageVersion.set(JavaLanguageVersion.of(17))
            }
        )
    }
}
