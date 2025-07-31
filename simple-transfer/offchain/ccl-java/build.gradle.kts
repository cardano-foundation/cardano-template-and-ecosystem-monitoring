plugins {
    id("java")
    application
}

group = "org.cardanofoundation"
version = "1.0-SNAPSHOT"

application {
    // Define the main class for the application
    mainClass.set("org.cardanofoundation.Main") // <-- Change this to your main class
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.bloxbean.cardano:cardano-client-lib:0.7.0-beta2")
    implementation("com.bloxbean.cardano:cardano-client-backend-blockfrost:0.7.0-beta2")


    testImplementation(platform("org.junit:junit-bom:5.10.0"))
    testImplementation("org.junit.jupiter:junit-jupiter")
}

tasks.test {
    useJUnitPlatform()
}