import org.gradle.jvm.toolchain.JavaToolchainService
import org.gradle.api.tasks.JavaExec
import org.gradle.api.tasks.SourceSetContainer
import java.nio.file.Files

plugins {
    kotlin("jvm") version "2.1.10"
    id("org.jetbrains.intellij") version "1.17.4"
}

group = "com.codexbridge"
version = "0.1.2"

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.1")
    testImplementation(kotlin("test"))
    testRuntimeOnly("org.junit.platform:junit-platform-console-standalone:1.10.1")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

fun normalizedLocalIdeaPath(projectDir: java.io.File): String {
    val rawHome = projectDir.resolve(".intellij-local")
    if (!rawHome.exists()) return rawHome.absolutePath
    if (rawHome.resolve("Contents").exists()) return rawHome.absolutePath
    if (!rawHome.resolve("product-info.json").exists()) return rawHome.absolutePath

    val appDir = projectDir.resolve(".intellij-local-app/IntelliJ IDEA.app")
    val wrapperContents = appDir.resolve("Contents")
    if (!wrapperContents.exists()) {
        appDir.mkdirs()
        runCatching {
            Files.createSymbolicLink(wrapperContents.toPath(), rawHome.toPath().toAbsolutePath())
        }
    }
    return wrapperContents.absolutePath
}

intellij {
    localPath.set(normalizedLocalIdeaPath(projectDir))
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
        incremental = false
    }

    withType<JavaCompile> {
        sourceCompatibility = "17"
        targetCompatibility = "17"
    }

    named("buildSearchableOptions") {
        enabled = false
    }

    val unitTest by register<JavaExec>("unitTest") {
        group = "verification"
        description = "Run pure JVM unit tests without the IntelliJ test runner."
        dependsOn("testClasses")
        classpath = sourceSets.getByName("test").runtimeClasspath
        mainClass.set("org.junit.platform.console.ConsoleLauncher")
        args("--scan-classpath")
        javaLauncher.set(
            javaToolchainService.launcherFor {
                languageVersion.set(JavaLanguageVersion.of(17))
            }
        )
    }

    test {
        dependsOn(unitTest)
        enabled = false
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
