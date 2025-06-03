
val scalusVersion = "0.10.0"

name := "payment-splitter"
organization := "org.scalus"
version := "0.10.0"
scalaVersion := "3.3.6"
libraryDependencies += "org.scalus" %% "scalus" % scalusVersion
libraryDependencies += "com.bloxbean.cardano" % "cardano-client-lib" % "0.6.4"
libraryDependencies += "org.scalus" %% "scalus-testkit" % scalusVersion % "test"
libraryDependencies += "org.scalatest" %% "scalatest" % "3.2.19" % "test"
libraryDependencies += "org.scalatestplus" %% "scalacheck-1-18" % "3.2.19.0" % "test"

addCompilerPlugin("org.scalus" %% "scalus-plugin" % scalusVersion )

