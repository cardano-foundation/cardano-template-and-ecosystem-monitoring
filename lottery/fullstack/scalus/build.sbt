ThisBuild / scalaVersion := "3.3.8"
ThisBuild / organization := "org.scalus.examples"
ThisBuild / version      := "0.1.0-SNAPSHOT"


val scalusVersion = "0.18.2"

lazy val root = (project in file("."))
    .enablePlugins(ScalusSbtPlugin)
    .settings(
        name := "lottery",
        scalacOptions ++= Seq("-deprecation", "-feature"),
        // Scalus's UPLC evaluator logs into a plain mutable ArrayBuffer
        // (scalus.uplc.eval.Log), which is not thread-safe. This example has three
        // suites and two of them evaluate many games concurrently, so running them
        // in parallel races that buffer and aborts LotteryValidatorTest with
        // "arraycopy: last source index 513 out of bounds for object array[512]" —
        // a torn resize, not a contract failure. Serial execution avoids the race.
        // Only this example needs it: the others have a single suite each.
        Test / parallelExecution := false,
        libraryDependencies ++= Seq(
            "org.scalus" %% "scalus"                % scalusVersion,
            "org.scalus" %% "scalus-cardano-ledger" % scalusVersion,
            "org.scalus" %% "scalus-testkit"         % scalusVersion % Test,
            "org.scalatest" %% "scalatest"           % "3.2.20"     % Test
        ),
        addCompilerPlugin(
            ("org.scalus" %% "scalus-plugin" % scalusVersion).cross(CrossVersion.full)
        ),
        Compile / sources := {
            val base = baseDirectory.value
            val testDir = base / "test"
            val targetDir = target.value
            (base ** "*.scala").get()
                .filterNot(f => f.relativeTo(testDir).isDefined)
                .filterNot(f => f.relativeTo(targetDir).isDefined)
                .toSeq
        },
        Test / sources := ((baseDirectory.value / "test") ** "*.scala")
            .get()
            .toSeq,
    )
