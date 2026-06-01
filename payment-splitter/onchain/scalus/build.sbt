
val scalusVersion = "0.10.0"

name := "payment-splitter"
organization := "org.scalus"
version := "0.10.0"
scalaVersion := "3.3.6"

addCompilerPlugin("org.scalus" %% "scalus-plugin" % scalusVersion)

libraryDependencies ++= Seq(
  "org.scalus" %% "scalus" % scalusVersion,
  "com.bloxbean.cardano" % "cardano-client-lib" % "0.6.4",
  "org.scalus" %% "scalus-testkit" % scalusVersion % Test,
  "org.scalatest" %% "scalatest" % "3.2.19" % Test,
  "org.scalatestplus" %% "scalacheck-1-18" % "3.2.19.0" % Test
)

Compile / mainClass := Some("scalus.examples.GenUplc")