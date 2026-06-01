val scalusVersion = "0.14.1"

name := "auction"
organization := "org.scalus"
version := "0.1.0"
scalaVersion := "3.3.7"

addCompilerPlugin("org.scalus" %% "scalus-plugin" % scalusVersion)

libraryDependencies ++= Seq(
  "org.scalus" %% "scalus" % scalusVersion,
  "com.bloxbean.cardano" % "cardano-client-lib" % "0.6.4",
  "org.scalus" %% "scalus-testkit" % scalusVersion % Test,
  "com.lihaoyi" %% "utest" % "0.9.4" % Test
)

testFrameworks += new TestFramework("utest.runner.Framework")

Compile / mainClass := Some("scalus.examples.auction.GeneratePlutus")